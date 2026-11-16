import { expect, it, vi } from 'vitest';
import { access } from 'node:fs/promises';
import { createPeerFixture } from './native-peer-fixture.js';

it('retains the parent owner across acknowledged native actor selection, reconnect and confirmed view exit', async () => {
  const ctx = await createPeerFixture(); const { supervisor } = ctx;
  try {
    const view = await supervisor.create('web-parent', 'live-session', { recordOutput: true });
    await vi.waitFor(() => expect(supervisor.get(view.id).nativeIdentityVerified).toBe(true));
    expect(supervisor.get(view.id).nativeId).toBe('parent-native'); expect(ctx.metrics().held).toBe(1);
    expect((await supervisor.create('web-parent', 'live-session')).id).toBe(view.id);
    expect(() => supervisor.input(view.id, 2, 'child\r')).toThrow('代际');
    ctx.deferIdentity(true); supervisor.input(view.id, 1, 'child\r');
    await vi.waitFor(() => expect(supervisor.get(view.id).nativeIdentityVerified).toBe(false));
    expect(() => supervisor.input(view.id, 1, 'next actor input\r')).toThrow('身份');
    ctx.acknowledge(); ctx.deferIdentity(false);
    await vi.waitFor(() => expect(supervisor.get(view.id).nativeId).toBe('child-native'));
    expect(ctx.parent).toEqual({ nativeId: 'parent-native', ownerId: 'original-owner' });
    expect(ctx.frames).toContainEqual({ direction: 'out', channel: `rpc-peer:${view.id}`, frame: { id: 2, method: 'thread/resume', params: { threadId: 'child-native' } } });
    const detach = supervisor.attach(view.id, 1, { send: () => undefined, close: () => undefined }); detach();
    const recovered: unknown[] = []; supervisor.attach(view.id, 1, { send: frame => recovered.push(frame), close: () => undefined });
    expect(recovered[0]).toMatchObject({ type: 'snapshot', terminal: { id: view.id, nativeId: 'child-native' } });
    const log = supervisor.log(view.id).path;
    expect((await supervisor.stop(view.id, 1)).state).toBe('exited'); expect(ctx.metrics()).toEqual({ held: 0, releases: 1 });
    await access(log); await supervisor.close(view.id); await expect(access(log)).rejects.toThrow();
    expect(supervisor.list('web-parent')).toEqual([]);
    const replacement = await supervisor.create('web-parent', 'live-session');
    await vi.waitFor(() => expect(supervisor.get(replacement.id).nativeIdentityVerified).toBe(true));
    ctx.replaceOwner();
    expect(() => supervisor.input(replacement.id, 1, 'child\r')).toThrow('stale owner');
    expect(() => supervisor.attach(replacement.id, 1, { send: () => undefined, close: () => undefined })).toThrow('stale owner');
    await vi.waitFor(() => expect(supervisor.list('web-parent')).toEqual([]));
    expect(ctx.metrics()).toEqual({ held: 0, releases: 2 }); expect(ctx.parent.ownerId).toBe('original-owner');
  } finally { await ctx.close(); }
});

it('blocks user text until the requested initial native identity is acknowledged', async () => {
  const ctx = await createPeerFixture(); ctx.deferIdentity(true);
  try {
    const view = await ctx.supervisor.create('web-parent', 'live-session');
    await vi.waitFor(() => expect(ctx.requests).toHaveLength(1));
    expect(() => ctx.supervisor.input(view.id, 1, 'user message\r')).toThrow('身份');
    ctx.acknowledge();
    await vi.waitFor(() => expect(ctx.supervisor.get(view.id).nativeIdentityVerified).toBe(true));
    expect(ctx.requests).toHaveLength(1);
  } finally { await ctx.close(); }
});

it('rejects a mismatched initial resume response and never exposes verified input', async () => {
  const ctx = await createPeerFixture(); ctx.wrongIdentity();
  try {
    const view = await ctx.supervisor.create('web-parent', 'live-session');
    await vi.waitFor(() => expect(ctx.supervisor.get(view.id).state).toBe('exited'));
    expect(ctx.supervisor.get(view.id).nativeIdentityVerified).toBe(false);
    expect(ctx.supervisor.get(view.id).nativeId).toBeNull();
    expect(ctx.metrics()).toEqual({ held: 0, releases: 1 });
  } finally { await ctx.close(); }
});

it('fences unrecorded peer requests without executing them or changing the parent', async () => {
  const ctx = await createPeerFixture();
  try {
    const view = await ctx.supervisor.create('web-parent', 'live-session');
    await vi.waitFor(() => expect(ctx.supervisor.get(view.id).nativeIdentityVerified).toBe(true));
    ctx.rejectRecording(); ctx.supervisor.input(view.id, 1, 'must not execute\r');
    await vi.waitFor(() => expect(ctx.supervisor.get(view.id).state).toBe('exited'));
    expect(ctx.requests).toHaveLength(1); expect(ctx.metrics()).toEqual({ held: 0, releases: 1 });
    expect(ctx.parent.ownerId).toBe('original-owner');
  } finally { await ctx.close(); }
});
