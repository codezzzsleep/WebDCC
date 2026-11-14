import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { NativeTerminalSupervisor, type NativeTerminalSupervisorDeps } from '../src/native-terminal.js';
import type { NativeTerminalTarget } from '../src/native-surface.js';

/** Real PTY fixture, deliberately not claimed as native Codex validation. */
export async function createTerminalFixture(options: { ignoreTerm?: boolean; replayBytes?: number; maxLogBytes?: number; nativeExecutable?: string; agent?: 'codex' | 'claude-code'; verifyNativeIdentity?: NativeTerminalSupervisorDeps['verifyNativeIdentity']; onIdentityInspection?: NativeTerminalSupervisorDeps['onIdentityInspection']; onReleased?: NativeTerminalSupervisorDeps['onReleased']; identityProbeIntervalMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wdcc-native-terminal-test-'));
  const cwd = join(root, 'workspace'); const profile = join(root, 'profile'); const home = join(root, 'home');
  await Promise.all([mkdir(cwd), mkdir(profile), mkdir(home)]);
  const executable = join(root, 'fixture.cjs');
  await writeFile(executable, `#!${process.execPath}
if(process.argv.includes('--version')) { console.log('codex-cli 0.167.0'); process.exit(0); }
if(process.env.FIXTURE_IGNORE_TERM==='yes') process.on('SIGTERM',()=>{});
process.stdout.write('\\x1b[32mREADY α🐈\\x1b[0m\\r\\n<img src=x onerror="globalThis.terminalInjected=true">\\r\\n');
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume(); let received='';
process.on('SIGWINCH',()=>process.stdout.write('SIZE '+process.stdout.rows+'x'+process.stdout.columns+'\\r\\n'));
process.stdin.on('data',data=>{
 if(data.includes('\\x03')) { process.stdout.write('DONE\\r\\n'); process.exit(0); }
 if(data.toString().includes('BIG')) process.stdout.write('X'.repeat(65536));
 else { received+=data; process.stdout.write('INPUT '+data+'\\r\\nINPUT-ALL '+received+'\\r\\n'); }
});
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const db = openDb(':memory:'); const store = new Store(db);
  const workspace = store.createWorkspace('PTY fixture', cwd);
  const agent = options.agent ?? 'codex';
  const source = store.createSession({ workspaceId: workspace.id, agent });
  const targets: NativeTerminalTarget[] = [];
  const supervisor = new NativeTerminalSupervisor({ owners: store.nativeOwners, replayBytes: options.replayBytes, maxLogBytes: options.maxLogBytes,
    verifyNativeIdentity: options.verifyNativeIdentity, onIdentityInspection: options.onIdentityInspection, onReleased: options.onReleased, identityProbeIntervalMs: options.identityProbeIntervalMs,
    logRoot: join(root, 'logs'), resolveTarget: async (sourceSessionId, intent) => {
      const target: NativeTerminalTarget = { sourceSessionId, ownerSessionId: intent === 'same-session' ? sourceSessionId : store.createSession({ workspaceId: workspace.id, agent }).id,
        agent, executable: options.nativeExecutable ?? executable, nativeVersion: agent === 'codex' ? '0.167.0' : '2.1.322', cwd, profilePath: profile, env: { HOME: home, CODEX_HOME: profile, CLAUDE_CONFIG_DIR: profile, PATH: '/usr/bin:/bin', FIXTURE_IGNORE_TERM: options.ignoreTerm ? 'yes' : 'no' } };
      targets.push(target); return target;
    } });
  return { root, cwd, profile, home, executable, db, store, source, targets, supervisor,
    async close() { await supervisor.dispose(); db.close(); await rm(root, { recursive: true, force: true }); } };
}

export async function terminalEventually(check: () => boolean, timeout = 5_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('terminal observation timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
