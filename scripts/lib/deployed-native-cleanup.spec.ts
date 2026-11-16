import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

it('cleans an untracked owned Web child and preserves a foreign child with the same private home', async () => {
  if (process.platform !== 'linux') return;
  const root = await mkdtemp(join(tmpdir(), 'wdcc-cleanup-owner-'));
  const home = join(root, 'profile'); await mkdir(home);
  const native = join(root, 'dsh');
  await writeFile(native, "process.stdout.write('READY\\n');setInterval(()=>{},1000);\n");
  const foreign = spawn(process.execPath, [native, 'web'], { env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = () => new Promise<void>((resolve, reject) => { foreign.stdout.once('data', () => resolve()); foreign.once('error', reject); });
  try {
    await ready();
    const helper = join(root, 'owner.mjs');
    const cleanup = pathToFileURL(fileURLToPath(new URL('../deployed-native-cleanup.mjs', import.meta.url))).href;
    await writeFile(helper, `import {spawn} from 'node:child_process';import {stopOwnedDsh} from ${JSON.stringify(cleanup)};
const child=spawn(process.execPath,[${JSON.stringify(native)},'web'],{env:{...process.env,DSH_HOME:${JSON.stringify(home)}},stdio:['ignore','pipe','pipe']});
await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject)});
const stopped=await stopOwnedDsh(${JSON.stringify(home)});let foreignAlive=true;try{process.kill(${foreign.pid!},0)}catch{foreignAlive=false}
process.stdout.write(JSON.stringify({ownedPid:child.pid,stopped,foreignAlive})+'\\n');\n`);
    const child = spawn(process.execPath, [helper], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { error += String(chunk); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    expect({ code, error }).toEqual({ code: 0, error: '' });
    const result = JSON.parse(output) as { ownedPid: number; stopped: number[]; foreignAlive: boolean };
    expect(result.stopped).toEqual([result.ownedPid]); expect(result.foreignAlive).toBe(true);
    expect(foreign.exitCode).toBeNull();
  } finally {
    if (foreign.exitCode === null && foreign.signalCode === null) {
      const exited = new Promise<void>(resolve => foreign.once('exit', () => resolve())); foreign.kill('SIGKILL'); await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
