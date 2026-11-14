import { expect, it } from 'vitest';
import { managedClaudeProcess } from '../src/managed-process.js';

it('NP-04 public SDK spawner captures a real child before first input and preserves env, cwd and stderr', async () => {
  let pid = 0; let errors = '';
  const controller = new AbortController();
  const child = managedClaudeProcess({ command: process.execPath, args: ['-e', "process.stdin.once('data', b => { process.stderr.write('tail'); process.stdout.write(JSON.stringify({ text: b.toString(), cwd: process.cwd(), value: process.env.WDCC_CHILD_TEST })); });"],
    cwd: '/tmp', env: { WDCC_CHILD_TEST: 'preserved' }, signal: controller.signal }, value => { pid = value; }, value => { errors += value; });
  try {
    expect(pid).toBeGreaterThan(0);
    let output = ''; child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stdin.write(' 字\n ');
    await expect.poll(() => output).not.toBe('');
    expect(JSON.parse(output)).toEqual({ text: ' 字\n ', cwd: '/tmp', value: 'preserved' });
    await expect.poll(() => errors).toBe('tail');
  } finally { child.kill('SIGKILL'); }
});

it('NP-04 forwarded SDK cancellation terminates the captured process; failed identity persistence prevents returning a writer', async () => {
  const controller = new AbortController();
  const child = managedClaudeProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, signal: controller.signal }, () => undefined);
  const exit = new Promise(resolve => child.once('exit', resolve)); controller.abort(); await exit;
  expect(child.killed).toBe(true);
  expect(() => managedClaudeProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, signal: new AbortController().signal }, () => { throw new Error('db unavailable'); })).toThrow('db unavailable');
});
