import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import type { ManagedProcessIdentity } from '@webdcc/protocol';
import { captureProcess, processState } from './process-identity.js';

const exec = promisify(execFile);
const valid = (profile: string, id: string): boolean => isAbsolute(profile) && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
// Matches rust-v0.167.0 rollout/src/writer_lock.rs: coordinate lock-file
// creation/removal before probing the thread's exclusive flock.
const probe = `import fcntl,json,os,sys
root=os.path.join(sys.argv[1],'thread-writer-locks')
try:
 with open(os.path.join(root,'.coordination.lock'),'r+') as coordination:
  fcntl.flock(coordination,fcntl.LOCK_EX|fcntl.LOCK_NB)
  path=os.path.join(root,sys.argv[2]+'.lock')
  try:
   with open(path,'r+') as thread:
    fcntl.flock(thread,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except FileNotFoundError: pass
 print(json.dumps({'released':True}))
except BlockingIOError: print(json.dumps({'released':False,'reason':'native writer or coordination lock is held'}))
except OSError: print(json.dumps({'released':False,'reason':'native writer lock cannot be verified'}))`;

export async function releasedCodexWriter(profile: string, id: string): Promise<{ released: boolean; verified: boolean; reference: string }> {
  if (!valid(profile, id)) return { released: false, verified: false, reference: 'invalid-native-lock-identity' };
  try {
    const { stdout } = await exec('/usr/bin/python3', ['-I', '-c', probe, profile, id], { timeout: 3_000, maxBuffer: 4_096 });
    const result = JSON.parse(stdout) as { released?: boolean; reason?: string };
    return { released: result.released === true, verified: result.released === true || result.reason === 'native writer or coordination lock is held', reference: `Codex0.167.0:thread-writer-locks/${id}.lock` };
  } catch { return { released: false, verified: false, reference: 'native-lock-probe-unavailable' }; }
}

/** Actual kernel lock ownership is required; a path or PID alone is insufficient. */
export async function holdsCodexWriter(profile: string, id: string, process: ManagedProcessIdentity): Promise<boolean> {
  if (!valid(profile, id) || processState(process) !== 'running') return false;
  const path = join(profile, 'thread-writer-locks', `${id}.lock`);
  const children = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8').catch(() => '')).trim().split(/\s+/).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0).slice(0, 32);
  for (const pid of [process.pid, ...children]) {
    const identity = pid === process.pid ? process : captureProcess(pid, profile); if (!identity) continue;
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => []);
    for (const fd of fds.slice(0, 256)) {
      if (await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '') !== path) continue;
      const info = await readFile(`/proc/${pid}/fdinfo/${fd}`, 'utf8').catch(() => '');
      if (/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s/m.test(info) && processState(identity) === 'running' && processState(process) === 'running') return true;
    }
  }
  return false;
}
