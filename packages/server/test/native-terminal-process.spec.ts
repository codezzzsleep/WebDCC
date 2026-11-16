import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeProcessSupervisor, type NativeProcessBridge, type NativeProcessCompletion, type NativeProcessDelta, type NativeProcessFrame } from '../src/native-terminal-process.js';
import { terminalEventually } from './native-terminal-fixture.js';

function processBridgeFixture() {
  let generation = 2;
  let output: (delta: NativeProcessDelta) => void = () => undefined;
  let complete: (value: NativeProcessCompletion) => void = () => undefined;
  let match = true;
  const calls: { method: string; params: unknown }[] = [];
  const bridge: NativeProcessBridge = {
    context: () => ({ identity: { ownerId: 'structured-owner', generation, hostId: 'test-host' }, nativeId: 'native-1', agent: 'codex', cwd: '/authorized/workspace', permissions: { source: 'native-command-config', matchesSession: match, description: 'read-only native command policy (verified)' } }),
    assert: (_session, identity) => { if (identity.generation !== generation) throw new Error('stale owner generation'); },
    start: async (_session, id, params, callback) => { calls.push({ method: 'start', params: { id, ...params } }); output = callback; return new Promise(resolve => { complete = resolve; }); },
    write: async (_session, params) => { calls.push({ method: 'write', params }); },
    resize: async (_session, params) => { calls.push({ method: 'resize', params }); },
    terminate: async (_session, params) => { calls.push({ method: 'terminate', params }); },
  };
  return { bridge, calls, emit: (bytes: Buffer, capReached = false) => output({ stream: 'stdout', deltaBase64: bytes.toString('base64'), capReached }), complete: () => complete({ exitCode: 7, stdout: '', stderr: '' }), fence: () => { generation++; }, mismatch: () => { match = false; } };
}

describe('native execution bridge contract (fixture, not native acceptance)', () => {
  it('uses argv/native stdin/native resize, reconstructs split UTF-8 and reconnects without a new command', async () => {
    const fixture = processBridgeFixture(); const states: { state: string; confirmed: boolean }[] = [];
    const supervisor = new NativeProcessSupervisor(fixture.bridge, { onState: view => states.push({ state: view.state, confirmed: view.confirmed }) });
    const process = await supervisor.start('web-1', ['python3', '-i'], { rows: 30, cols: 100 });
    expect(process.state).toBe('starting'); expect(process.confirmed).toBe(false);
    const frames: unknown[] = [];
    const detach = supervisor.attach(process.id, process.generation, { send: frame => frames.push(frame), close: () => undefined });
    const unicode = Buffer.from('🐈你好'); fixture.emit(unicode.subarray(0, 2)); fixture.emit(unicode.subarray(2));
    expect(states[0]).toEqual({ state: 'running', confirmed: true });
    detach(); const reconnect = supervisor.attach(process.id, process.generation, { send: frame => frames.push(frame), close: () => undefined });
    expect(JSON.stringify(frames)).toContain('🐈你好'); expect(fixture.calls.filter(call => call.method === 'start')).toHaveLength(1);
    await supervisor.write(process.id, process.generation, 'stdin-你好'); await supervisor.resize(process.id, process.generation, 45, 132);
    expect(fixture.calls.find(call => call.method === 'write')?.params).toEqual({ processId: process.id, deltaBase64: Buffer.from('stdin-你好').toString('base64'), closeStdin: false });
    expect(fixture.calls.find(call => call.method === 'resize')?.params).toEqual({ processId: process.id, size: { rows: 45, cols: 132 } });
    reconnect(); fixture.complete(); await terminalEventually(() => supervisor.get(process.id).state === 'exited');
    expect(supervisor.get(process.id).exitCode).toBe(7); await supervisor.close(process.id, process.generation);
    expect(states.at(-1)).toEqual({ state: 'exited', confirmed: true });
    expect(supervisor.metrics()).toEqual({ processes: 0, clients: 0, replayBytes: 0, logFiles: 0 });
  });
  it('does not treat terminate ACK as an exit confirmation', async () => {
    const fixture = processBridgeFixture(); const supervisor = new NativeProcessSupervisor(fixture.bridge, { exitTimeoutMs: 20 });
    const process = await supervisor.start('web-1', ['cat'], { rows: 30, cols: 100 });
    await expect(supervisor.stop(process.id, process.generation)).rejects.toThrow('exit'); expect(supervisor.get(process.id).state).toBe('uncertain');
    fixture.complete(); await terminalEventually(() => supervisor.get(process.id).state === 'exited'); await supervisor.dispose();
  });
  it('broadcasts a native cap while the process is running and keeps reconnect/log status consistent', async () => {
    const fixture = processBridgeFixture();
    const logRoot = await mkdtemp(join(tmpdir(), 'wdcc-process-cap-'));
    const states: { state: string; truncated: boolean }[] = [];
    const supervisor = new NativeProcessSupervisor(fixture.bridge, { logRoot, onState: view => states.push({ state: view.state, truncated: view.outputTruncated }) });
    const process = await supervisor.start('web-1', ['cat'], { rows: 30, cols: 100 }, true);
    const frames: NativeProcessFrame[] = [];
    try {
      const detach = supervisor.attach(process.id, process.generation, { send: frame => frames.push(frame), close: () => undefined });
      fixture.emit(Buffer.from('Retained native output 😀\n'));
      fixture.emit(Buffer.alloc(0), true);
      const capped = frames.filter(frame => frame.type === 'state').at(-1);
      expect(capped).toMatchObject({ type: 'state', process: { id: process.id, generation: process.generation, state: 'running', exitCode: null, confirmed: true, outputTruncated: true } });
      expect(states).toEqual([{ state: 'running', truncated: false }, { state: 'running', truncated: true }]);
      for (let index = 0; index < 10; index++) fixture.emit(Buffer.alloc(0), true);
      expect(states).toHaveLength(2);
      expect(fixture.calls.filter(call => call.method === 'terminate')).toHaveLength(0);
      const log = supervisor.log(process.id);
      expect(log.truncated).toBe(true);
      expect(await readFile(log.path, 'utf8')).toBe('Retained native output 😀\n');
      detach();
      const reconnect = supervisor.attach(process.id, process.generation, { send: frame => frames.push(frame), close: () => undefined });
      expect(frames.at(-1)).toMatchObject({ type: 'snapshot', process: { id: process.id, outputTruncated: true, state: 'running' } });
      reconnect();
    } finally {
      fixture.complete();
      await terminalEventually(() => supervisor.get(process.id).state === 'exited');
      await supervisor.dispose();
      await rm(logRoot, { recursive: true, force: true });
    }
    expect(supervisor.metrics()).toEqual({ processes: 0, clients: 0, replayBytes: 0, logFiles: 0 });
  });
  it('includes a cap reported by the first delta in the initial running state', async () => {
    const fixture = processBridgeFixture();
    const states: { state: string; truncated: boolean }[] = [];
    const supervisor = new NativeProcessSupervisor(fixture.bridge, { onState: view => states.push({ state: view.state, truncated: view.outputTruncated }) });
    const process = await supervisor.start('web-1', ['cat'], { rows: 30, cols: 100 });
    try {
      fixture.emit(Buffer.from('First partial output'), true);
      expect(states).toEqual([{ state: 'running', truncated: true }]);
    } finally {
      fixture.complete();
      await terminalEventually(() => supervisor.get(process.id).state === 'exited');
      await supervisor.dispose();
    }
  });
  it('blocks sandbox mismatch and fences old output and stdin', async () => {
    const fixture = processBridgeFixture(); const supervisor = new NativeProcessSupervisor(fixture.bridge);
    fixture.mismatch(); await expect(supervisor.start('web-1', ['cat'], { rows: 30, cols: 100 })).rejects.toThrow('权限'); expect(fixture.calls).toHaveLength(0);
  });
  it('never writes through an owner after its generation changes', async () => {
    const fixture = processBridgeFixture(); const supervisor = new NativeProcessSupervisor(fixture.bridge);
    const process = await supervisor.start('web-1', ['cat'], { rows: 30, cols: 100 }); fixture.fence();
    await expect(supervisor.write(process.id, process.generation, 'bad')).rejects.toThrow('stale'); fixture.emit(Buffer.from('late old output'), true);
    expect(supervisor.get(process.id).outputTruncated).toBe(false); fixture.complete();
    await terminalEventually(() => supervisor.get(process.id).state === 'uncertain'); expect(supervisor.get(process.id).exitCode).toBeNull();
  });
});
