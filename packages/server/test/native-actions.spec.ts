import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

it('native process acknowledgement belongs to one resource; an earlier process cannot confirm the next start', async () => {
  const db = openDb(':memory:'); const store = new Store(db);
  const workspace = store.createWorkspace('reference', '/tmp'); const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
  const identity = { ownerId: 'owner', generation: 1, hostId: 'host' };
  const start = (commandId: string, id: string) => store.nativeActions.execute(session.id, { commandId, action: { type: 'native-process-start' } }, async () => {
    store.nativeActions.bind(commandId, identity, 'native'); return { id, confirmed: false };
  });
  try {
    await start('first-process-command', 'process-1');
    store.nativeActions.confirmReference(session.id, identity, 'native', 'native-process-start', 'process-1');
    expect(store.nativeActions.get('first-process-command', session.id)?.state).toBe('completed');
    await start('second-process-command', 'process-2');
    store.nativeActions.confirmReference(session.id, identity, 'native', 'native-process-start', 'process-1');
    expect(store.nativeActions.get('second-process-command', session.id)?.state).toBe('submitted');
    store.nativeActions.confirmReference(session.id, { ...identity, generation: 0 }, 'native', 'native-process-start', 'process-2');
    expect(store.nativeActions.get('second-process-command', session.id)?.state).toBe('submitted');
    store.nativeActions.confirmReference(session.id, identity, 'native', 'native-process-start', 'process-2');
    expect(store.nativeActions.get('second-process-command', session.id)?.state).toBe('completed');
  } finally { db.close(); }
});

it('a late native return cannot overwrite the uncertain result established by disconnect', async () => {
  const db = openDb(':memory:'); const store = new Store(db);
  const workspace = store.createWorkspace('late', '/tmp'); const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' });
  const identity = { ownerId: 'owner', generation: 1, hostId: 'host' };
  try {
    const response = await store.nativeActions.execute(session.id, { commandId: 'late-return-command', action: { type: 'native-process-start' } }, async () => {
      store.nativeActions.bind('late-return-command', identity, 'native');
      store.nativeActions.disconnect(session.id, identity);
      return { id: 'late-process', confirmed: false };
    });
    expect(response.receipt).toMatchObject({ state: 'uncertain', error: 'native-connection-closed' });
    store.nativeActions.confirmReference(session.id, identity, 'native', 'native-process-start', 'late-process');
    expect(store.nativeActions.get('late-return-command', session.id)?.state).toBe('uncertain');
  } finally { db.close(); }
});

it('native actions survive a real dispatcher SIGKILL without storing or replaying its payload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-native-action-kill-'));
  const file = join(directory, 'database.sqlite');
  const db = openDb(file); const store = new Store(db);
  const workspace = store.createWorkspace('kill', directory);
  const session = store.createSession({ workspaceId: workspace.id, agent: 'codex' }); db.close();
  const code = `import { openDb } from './packages/server/src/db.ts'; import { Store } from './packages/server/src/store.ts';
const store = new Store(openDb(process.argv[1]));
setInterval(()=>{},1000);
await store.nativeActions.execute(process.argv[2], {commandId:'killed-command',action:{type:'elicitation',requestId:'native-request',content:'never-store-this-secret'}}, async()=>{process.send('claimed');await new Promise(()=>{});});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, file, session.id], { cwd: resolve('.'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errorOutput = ''; child.stderr?.on('data', value => { errorOutput += String(value); });
  try {
    const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(`Dispatcher exited before claim: ${errorOutput}`); })]);
    expect(message[0]).toBe('claimed');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const reopened = openDb(file);
    try {
      const restored = new Store(reopened); let repeated = 0;
      const request = { commandId: 'killed-command', action: { type: 'elicitation', requestId: 'native-request', content: 'never-store-this-secret' } };
      expect(restored.nativeActions.get(request.commandId, session.id)?.state).toBe('uncertain');
      expect((await restored.nativeActions.execute(session.id, request, async () => { repeated++; })).receipt.state).toBe('uncertain');
      await expect(restored.nativeActions.execute(session.id, { ...request, commandId: 'fresh-after-kill' }, async () => { repeated++; })).rejects.toThrow('不能重复提交');
      expect(repeated).toBe(0);
      expect(JSON.stringify(reopened.prepare('SELECT * FROM native_actions').all())).not.toContain('never-store-this-secret');
    } finally { reopened.close(); }
    expect((await readFile(file)).includes(Buffer.from('never-store-this-secret'))).toBe(false);
  } finally { child.kill('SIGKILL'); if (child.connected) child.disconnect(); await rm(directory, { recursive: true, force: true }); }
}, 20_000);
