import { readFile, readdir, stat } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { issueCookie } from '../src/auth.js';
import { registerNativeTerminalRoutes } from '../src/native-terminal-routes.js';
import { NativeTerminalOutput } from '../src/native-terminal-buffer.js';
import { nativeTerminalArgv, validateNativeTakeover } from '../src/native-surface.js';
import { captureProcess } from '../src/process-identity.js';
import { createTerminalFixture, terminalEventually } from './native-terminal-fixture.js';

describe('native CLI terminal real PTY lifecycle and boundaries', () => {
  it('continuous identity monitoring fences drift and preserves uncertain ownership after confirmed PTY exit', async () => {
    let nativeId = 'native-fixture-a'; let inspections = 0;
    const changes: unknown[] = []; const releases: boolean[] = [];
    const ctx = await createTerminalFixture({ identityProbeIntervalMs: 20, verifyNativeIdentity: async () => { inspections++; return { nativeId, evidence: 'fixture-only' }; }, onIdentityInspection: (_target, change) => changes.push(change), onReleased: (_target, verified) => { releases.push(verified); } });
    try {
      const terminal = await ctx.supervisor.create(ctx.source.id, 'new-native');
      expect(terminal.nativeIdentityVerified).toBe(true);
      expect(ctx.supervisor.list(terminal.ownerSessionId)[0]?.id).toBe(terminal.id);
      await terminalEventually(() => inspections >= 3);
      const workspace = ctx.store.getWorkspace(ctx.source.workspaceId)!;
      const foreign = ctx.store.createSession({ workspaceId: workspace.id, agent: 'codex' });
      const foreignIdentity = ctx.store.nativeOwners.acquire('foreign-fixture-owner', foreign.id, 'codex', 'native-fixture-b');
      ctx.store.nativeOwners.activate(foreign.id, foreignIdentity, 'native-fixture-b');
      ctx.supervisor.input(terminal.id, terminal.generation, 'private-pty-input');
      nativeId = 'native-fixture-b';
      await terminalEventually(() => ctx.supervisor.get(terminal.id).state === 'exited');
      const view = ctx.supervisor.get(terminal.id);
      expect(view.nativeId).toBe('native-fixture-a'); expect(view.nativeIdentityVerified).toBe(false);
      expect(view.identityInspection.state).toBe('drifted'); expect(view.identityInspection.nativeId).toBe('native-fixture-b');
      expect(ctx.store.nativeOwners.get(terminal.ownerSessionId)?.state).toBe('uncertain');
      expect(ctx.store.nativeOwners.current(foreign.id, foreignIdentity)).toBe(true);
      expect(() => ctx.supervisor.input(terminal.id, terminal.generation, 'bad')).toThrow('代际');
      expect(JSON.stringify(changes)).not.toContain('private-pty-input'); expect(view.identityChanges.length).toBeLessThanOrEqual(16);
      await ctx.supervisor.close(terminal.id); expect(ctx.supervisor.metrics().processes).toBe(0);
      expect(releases).toEqual([false]);
    } finally { await ctx.close(); }
  });
  it('continuous identity monitoring stops when a bound native identity becomes unverifiable', async () => {
    let available = true;
    const ctx = await createTerminalFixture({ identityProbeIntervalMs: 20, verifyNativeIdentity: async () => available ? { nativeId: 'native-fixture-a', evidence: 'fixture-only' } : undefined });
    try {
      const terminal = await ctx.supervisor.create(ctx.source.id, 'new-native'); available = false;
      await terminalEventually(() => ctx.supervisor.get(terminal.id).state === 'exited');
      expect(ctx.supervisor.get(terminal.id).identityInspection.state).toBe('uncertain');
      expect(ctx.store.nativeOwners.get(terminal.ownerSessionId)?.state).toBe('uncertain');
      expect(() => ctx.supervisor.input(terminal.id, terminal.generation, 'bad')).toThrow('代际');
      await ctx.supervisor.close(terminal.id); expect(ctx.supervisor.metrics().listeners).toBe(0);
    } finally { await ctx.close(); }
  });
  it('keeps the same duplex process across detach/reconnect, supports UTF-8 and resize, and clears resources', async () => {
    const ctx = await createTerminalFixture({ ignoreTerm: true });
    const fdBaseline = readdirSync('/proc/self/fd').length;
    try {
      const terminal = await ctx.supervisor.create(ctx.source.id, 'new-native', { recordOutput: true });
      const read = () => ctx.supervisor.snapshot(terminal.id).chunks.map(chunk => chunk.data).join('');
      await terminalEventually(() => read().includes('READY α🐈'));
      expect(terminal.nativeIdentityVerified).toBe(false);
      const frames: unknown[] = [];
      const detach = ctx.supervisor.attach(terminal.id, terminal.generation, { send: frame => frames.push(frame), close: () => undefined });
      detach();
      expect(ctx.supervisor.metrics().clients).toBe(0);
      expect(ctx.supervisor.get(terminal.id).process.pid).toBe(terminal.process.pid);
      ctx.supervisor.input(terminal.id, terminal.generation, '你好🐈');
      await terminalEventually(() => read().includes('INPUT 你好🐈'));
      ctx.supervisor.resize(terminal.id, terminal.generation, 37, 121);
      await terminalEventually(() => read().includes('SIZE 37x121'));
      const detach2 = ctx.supervisor.attach(terminal.id, terminal.generation, { send: frame => frames.push(frame), close: () => undefined });
      expect(ctx.supervisor.metrics().processes).toBe(1);
      detach2();
      const log = ctx.supervisor.log(terminal.id);
      expect((await stat(log.path)).mode & 0o777).toBe(0o600);
      expect(await readFile(log.path, 'utf8')).toContain('INPUT 你好🐈');
      const exit = await ctx.supervisor.stop(terminal.id, terminal.generation);
      expect(exit.state).toBe('exited'); expect(exit.exitSignal).toBe(9);
      expect(ctx.store.nativeOwners.get(terminal.ownerSessionId)?.state).toBe('released');
      await ctx.supervisor.close(terminal.id);
      expect(ctx.supervisor.metrics()).toEqual({ terminals: 0, processes: 0, ptys: 0, clients: 0, listeners: 0, replayBytes: 0, logFiles: 0 });
      expect(readdirSync('/proc/self/fd').length).toBe(fdBaseline);
      expect(await readdir(join(ctx.root, 'logs'))).toEqual([]);
    } finally { await ctx.close(); }
  });

  it('bounds replay and log storage, reports truncation and confirms stop', async () => {
    const ctx = await createTerminalFixture({ replayBytes: 1_024, maxLogBytes: 4_096 });
    try {
      const terminal = await ctx.supervisor.create(ctx.source.id, 'new-native', { recordOutput: true });
      await terminalEventually(() => ctx.supervisor.snapshot(terminal.id).lastSeq > 0);
      ctx.supervisor.input(terminal.id, terminal.generation, 'BIG');
      await terminalEventually(() => ctx.supervisor.get(terminal.id).state === 'exited');
      expect(ctx.supervisor.get(terminal.id).outputTruncated).toBe(true);
      expect(ctx.supervisor.metrics().replayBytes).toBeLessThanOrEqual(1_024);
      expect((await stat(ctx.supervisor.log(terminal.id).path)).size).toBeLessThanOrEqual(4_096);
      expect(ctx.supervisor.snapshot(terminal.id).gap).toBe(true);
    } finally { await ctx.close(); }
  });

  it('rejects old generations and does not treat a lease/release as proof of external takeover', async () => {
    const ctx = await createTerminalFixture();
    try {
      const terminal = await ctx.supervisor.create(ctx.source.id, 'new-native');
      expect(() => ctx.supervisor.input(terminal.id, terminal.generation - 1, 'bad')).toThrow('代际');
      await expect(ctx.supervisor.create(ctx.source.id, 'same-session')).rejects.toThrow('原生身份');
      const target = ctx.targets[0]!;
      expect(() => validateNativeTakeover({ ...target, nativeId: 'native-test', takeoverEvidence: {
        nativeId: 'native-test', cwd: target.cwd, profilePath: target.profilePath, nativeVersion: target.nativeVersion, checkedAt: new Date().toISOString(),
        previousOwnerReleased: true, previousProcess: captureProcess(process.pid)!, historyReconciled: true, effectiveSettingsReconciled: true, externalWriter: 'unknown',
      } })).toThrow('未验证退出');
      const identity = ctx.store.nativeOwners.get(terminal.ownerSessionId)!;
      ctx.store.nativeOwners.release(terminal.ownerSessionId, { ownerId: identity.ownerId, generation: identity.generation, hostId: identity.hostId }, false);
      expect(() => ctx.supervisor.input(terminal.id, terminal.generation, 'bad')).toThrow('代际');
    } finally { await ctx.close(); }
  });

  it('requires authentication and same origin and rejects caller argv/cwd before spawn', async () => {
    const ctx = await createTerminalFixture(); const app = Fastify();
    const token = 'native-terminal-test-token'; const cookie = `wdcc-auth=${issueCookie(token)}`;
    await app.register(websocket);
    registerNativeTerminalRoutes(app, { supervisor: ctx.supervisor, config: { host: '127.0.0.1', port: 0, token }, executeControl: async (_action, run) => run() });
    try {
      const unauthorized = await app.inject({ url: `/api/native-terminal?sessionId=${ctx.source.id}` }); expect(unauthorized.statusCode).toBe(401);
      const cross = await app.inject({ method: 'POST', url: '/api/native-terminal', headers: { cookie, origin: 'https://evil.example' }, payload: { sessionId: ctx.source.id, intent: 'new-native', commandId: 'terminal-create-1' } }); expect(cross.statusCode).toBe(403);
      const arbitrary = await app.inject({ method: 'POST', url: '/api/native-terminal', headers: { cookie }, payload: { sessionId: ctx.source.id, intent: 'new-native', commandId: 'terminal-create-2', cwd: '/etc', argv: ['sh'] } }); expect(arbitrary.statusCode).toBe(400);
      expect(ctx.supervisor.metrics().processes).toBe(0);
      const terminal = await ctx.supervisor.create(ctx.source.id, 'new-native');
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const ws = new WebSocket(address.replace('http:', 'ws:') + `/api/native-terminal/${terminal.id}/stream?generation=${terminal.generation - 1}`, { headers: { cookie, origin: address } });
      const [code] = await once(ws, 'close'); expect(code).toBe(1008);
      const denied = new WebSocket(address.replace('http:', 'ws:') + `/api/native-terminal/${terminal.id}/stream?generation=${terminal.generation}`, { headers: { cookie, origin: 'https://evil.example' } });
      const [error] = await once(denied, 'error'); expect(String(error)).toContain('403');
    } finally { await app.close(); await ctx.close(); }
  });
});

it('uses fixed native argv without prompts, permissions, or shell interpolation', async () => {
  const ctx = await createTerminalFixture();
  try {
    await ctx.supervisor.create(ctx.source.id, 'new-native');
    expect(nativeTerminalArgv(ctx.targets[0]!, 'new-native')).toEqual(['--no-daemon', '--no-alt-screen', '--cd', ctx.cwd]);
  } finally { await ctx.close(); }
});

it('keeps sequence watermarks when earlier output is evicted', () => {
  const output = new NativeTerminalOutput(8);
  output.append('one'); output.append('two'); output.append('three');
  expect(output.snapshot()).toEqual({ chunks: [{ seq: 2, data: 'two' }, { seq: 3, data: 'three' }], firstSeq: 2, lastSeq: 3, gap: true });
  output.dispose(); expect(output.metrics().replayBytes).toBe(0);
});
