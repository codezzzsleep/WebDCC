import { expect, it, vi } from 'vitest';
import { DshAdapter, providerForModel } from '../src/adapter.js';
import { dshNativeActionMetadata, dshNativeCall, dshPublicValue, parseDshNativeAction, DSH_NATIVE_CONTROLS } from '../src/native.js';
import { validateDshArgs } from '../src/contracts.js';
import type { DshHostClient } from '../src/host.js';
import type { DshHostIdentity } from '../src/identity.js';

const host: DshHostIdentity = { url: 'http://host.test/dsh/', version: '0.2.2-rc.1', status: 'verified', source: 'native-bootstrap', fingerprint: 'build', profile: { scope: 'current-host-profile', identity: 'unavailable-in-api' } };
const revision = 'native-revision';
const goal = { id: 'goal', revision: 2 };
const cases = [
  { type: 'model', provider: 'provider', model: 'model', reasoningEffort: 'high' }, { type: 'preset', agentPreset: 'standard' }, { type: 'rename', title: '  original title  ' },
  { type: 'pin', pinned: true }, { type: 'archive', archived: true, stopActivity: false }, { type: 'fork', atSeq: 10, allowMigration: false }, { type: 'compact' },
  { type: 'settings-mutate', ns: 'agent-default-model', ops: [{ op: 'set', path: ['model'], value: 'model' }], expectedRevision: 2 },
  { type: 'goal-create', objective: '  original\r\nobjective  ', maxGoalRounds: 3 }, { type: 'goal-edit', ref: goal, objective: 'next' },
  { type: 'goal-pause', ref: goal }, { type: 'goal-resume', ref: goal }, { type: 'goal-complete', ref: goal }, { type: 'goal-clear', ref: goal },
  { type: 'schedule-create', request: { title: 'reminder', prompt: '  exact prompt  ', timing: { kind: 'at', at: { date: '2026-11-01', time: '01:30:00', time_zone: 'America/New_York' } }, target: { kind: 'session', sessionId: 'target' } } },
  { type: 'schedule-edit', request: { id: 'schedule', action: 'update', expectedUpdatedAt: '2026-11-14T00:00:00Z', patch: { active: false } } },
  { type: 'schedule-run', id: 'schedule' }, { type: 'child-prompt', childSessionId: 'child', text: '  exact\r\ntext  ', requestId: 'request', delivery: 'steer' },
  { type: 'child-interrupt', childSessionId: 'child' }, { type: 'job-kill', jobId: 'job' }, { type: 'card-dismiss', callId: 'card' },
  { type: 'forge-worktree', from: null }, { type: 'forge-cancel' }, { type: 'forge-restore' }, { type: 'forge-retry' }, { type: 'forge-stop' }, { type: 'forge-refresh' },
];
it('all finite DSH controls use the frozen 193-endpoint contract and preserve human text', () => {
  expect(new Set(cases.map(action => action.type))).toEqual(new Set(DSH_NATIVE_CONTROLS));
  for (const input of cases) {
    const action = parseDshNativeAction({ ...input, revision });
    const call = dshNativeCall(action, 'actual-parent');
    expect(() => validateDshArgs(call.endpoint, call.args)).not.toThrow();
  }
  const action = parseDshNativeAction({ ...cases.find(action => action.type === 'child-prompt'), revision });
  expect(dshNativeCall(action, 'actual-parent')).toMatchObject({ endpoint: 'subagents/prompt', args: { request: { parentSessionId: 'actual-parent', mode: 'continuable', content: [{ type: 'text', text: '  exact\r\ntext  ' }] } } });
  expect(() => parseDshNativeAction({ type: 'rpc', endpoint: 'credentials/set', revision })).toThrow('Unknown');
  expect(() => parseDshNativeAction({ type: 'goal-pause', ref: goal })).toThrow('revision');
  expect(() => parseDshNativeAction({ type: 'child-interrupt', childSessionId: 'child', parentSessionId: 'another', revision })).toThrow('field');
  expect(() => parseDshNativeAction({ type: 'card-dismiss', callId: 'card', verb: 'execute', revision })).toThrow('field');
});

it('schedule forms preserve explicit DST-zone semantics and force native edit CAS', () => {
  const create = (timing: unknown) => parseDshNativeAction({ type: 'schedule-create', revision, request: { title: 'task', prompt: 'prompt', timing } });
  expect(() => create({ kind: 'at', at: '2026-11-01T01:30:00' })).toThrow('offset');
  expect(() => create({ kind: 'at', at: '2026-11-01T01:30:00-04:00' })).not.toThrow();
  expect(() => create({ kind: 'daily', daily: { time: '01:30:00', time_zone: 'Not/AZone' } })).toThrow('zone');
  expect(() => create({ kind: 'weekly', weekly: { time: '01:30:00', time_zone: 'UTC', weekdays: [1, 1] } })).toThrow('unique');
  expect(() => create({ kind: 'after', after_seconds: 1.5 })).toThrow('integer');
  expect(() => parseDshNativeAction({ type: 'schedule-edit', revision, request: { id: 'task', action: 'delete' } })).toThrow('updatedAt');
});

it('catalog actions are finite forms, omit the dispatch envelope, and hide entity-owned revisions', () => {
  const actions = dshNativeActionMetadata(true, { forge: { unavailable: true } });
  expect(actions.map(action => action.type)).toEqual(DSH_NATIVE_CONTROLS);
  for (const action of actions) {
    expect(action.schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(action.schema.properties).not.toHaveProperty('type');
    expect(action.schema.properties).not.toHaveProperty('revision');
  }
  expect(actions.find(action => action.type === 'settings-mutate')?.schema.properties['expectedRevision']).toMatchObject({ readOnly: true });
  expect(actions.find(action => action.type === 'forge-worktree')?.supported).toBe(false);
  expect(dshNativeActionMetadata(false).every(action => action.supported === false)).toBe(true);
  expect(dshPublicValue({ token: 'private', config: { apiKey: 'hidden', baseURL: 'https://name:secret@host.test/api?key=private' } })).toEqual({ token: '[redacted]', config: { apiKey: '[redacted]', baseURL: 'https://host.test/api' } });
});

function controller(options: { blank?: boolean; projectionBehind?: boolean; forge?: Record<string, unknown> } = {}) {
  const replay = DshAdapter.replay('local');
  replay.feed({ i: 1, t: 0, dir: 'in', ch: 'mux:$events', frame: { value: { type: 'snapshot', header: { id: 'native-parent' }, cursor: -1, records: [], hasMore: false } } });
  let cursor = 1;
  const writes: { endpoint: string; args: Record<string, unknown> }[] = [];
  const rpc = async (endpoint: string, args: Record<string, unknown>) => {
    if (endpoint === 'session/state') return { cursor, active: true, running: false, queue: [], pendingInput: [] };
    if (endpoint === 'session/projections') return { asOfSeq: options.projectionBehind ? cursor - 1 : cursor, values: { permissions: { currentValue: 'read-only' }, subagentCatalog: [{ id: 'child', mode: 'continuable' }], ...(options.blank === undefined ? {} : { sessionListMetadata: { blank: options.blank } }) } };
    if (endpoint === 'session/modelCatalog') return { groups: [{ id: 'one', models: [{ id: 'same', reasoning: { efforts: [{ id: 'high' }] } }] }, { id: 'two', models: [{ id: 'same' }] }] };
    if (endpoint === 'agentPresets/list') return { presets: [{ id: 'standard' }] };
    if (endpoint === 'settings/describe') return { writable: true, hasDocument: true, namespaces: [{ ns: 'known', revision: 2 }] };
    if (endpoint === 'goals/create') { writes.push({ endpoint, args }); cursor++; return { ref: goal }; }
    if (endpoint === 'subagents/prompt') { writes.push({ endpoint, args }); return { accepted: true }; }
    writes.push({ endpoint, args }); return {};
  };
  Object.assign(replay.adapter, { client: { connect: async () => undefined, isConnected: true, rpc, snapshot: async () => options.forge } as unknown as DshHostClient });
  vi.spyOn(replay.adapter, 'hostIdentity').mockResolvedValue(host);
  return { adapter: replay.adapter, writes, change() { cursor++; } };
}
it('the adapter fences stale actions and reads native state back after a goal mutation', async () => {
  const { adapter, writes, change } = controller();
  const state = await adapter.nativeState('local') as { revision: string };
  change();
  await expect(adapter.executeNativeControl('local', { type: 'goal-create', objective: 'exact', revision: state.revision })).rejects.toMatchObject({ statusCode: 409, code: 'native-control-rejected' });
  expect(writes).toEqual([]);
  const refreshed = await adapter.nativeState('local') as { revision: string };
  const result = await adapter.executeNativeControl('local', { type: 'goal-create', objective: '  exact\r\n  ', revision: refreshed.revision }) as { state: { revision: string } };
  expect(writes).toEqual([{ endpoint: 'goals/create', args: { agentId: 'native-parent', request: { objective: '  exact\r\n  ' } } }]);
  expect(result.state.revision).not.toBe(refreshed.revision);
});
it('unknown actual Host identity blocks writes, and direct-child controls cannot escape their parent', async () => {
  const { adapter, writes } = controller();
  vi.mocked(adapter.hostIdentity).mockResolvedValue({ ...host, version: undefined, status: 'unknown', reason: 'Host release missing' });
  const state = await adapter.nativeState('local') as { revision: string };
  await expect(adapter.executeNativeControl('local', { type: 'goal-create', objective: 'exact', revision: state.revision })).rejects.toMatchObject({ code: 'native-control-rejected', reasonCode: 'dsh-host-version-blocked' });
  expect(writes).toEqual([]);
  vi.mocked(adapter.hostIdentity).mockResolvedValue(host);
  const current = await adapter.nativeState('local') as { revision: string };
  await expect(adapter.executeNativeControl('local', { type: 'child-prompt', childSessionId: 'other', text: 'x', delivery: 'queue', requestId: 'request', revision: current.revision })).rejects.toMatchObject({ statusCode: 409 });
  expect(writes).toEqual([]);
});
it('model discovery retains distinct identities when two native providers advertise one model ID', async () => {
  const { adapter } = controller();
  const models = await adapter.listModels();
  expect(models).toHaveLength(2);
  expect(new Set(models.map(model => model.id)).size).toBe(2);
  expect(models.every(model => model.id.startsWith('dsh:'))).toBe(true);
  expect(providerForModel({ groups: [{ id: 'one', models: [{ id: 'same' }] }, { id: 'two', models: [{ id: 'same' }] }] }, 'same')).toBeUndefined();
});

it('a successful mutation survives failed readback, while a lost mutation response stays uncertain', async () => {
  const first = controller();
  const client = (first.adapter as unknown as { client: DshHostClient }).client;
  const rpc = client.rpc;
  let readbackFails = false;
  client.rpc = async <T>(endpoint: string, args: Record<string, unknown>) => {
    if (readbackFails) throw new Error('readback unavailable');
    const result = await rpc<T>(endpoint, args);
    if (endpoint === 'goals/create') readbackFails = true;
    return result;
  };
  const state = await first.adapter.nativeState('local') as { revision: string };
  expect(await first.adapter.executeNativeControl('local', { type: 'goal-create', objective: 'exact', revision: state.revision })).toMatchObject({ result: { ref: goal }, state: { unavailable: true } });
  expect(first.writes).toHaveLength(1);
  const second = controller();
  const secondClient = (second.adapter as unknown as { client: DshHostClient }).client;
  const original = secondClient.rpc;
  secondClient.rpc = async <T>(endpoint: string, args: Record<string, unknown>) => {
    if (endpoint === 'goals/create') throw new Error('response lost');
    return original<T>(endpoint, args);
  };
  const current = await second.adapter.nativeState('local') as { revision: string };
  await expect(second.adapter.executeNativeControl('local', { type: 'goal-create', objective: 'exact', revision: current.revision })).rejects.toMatchObject({ code: 'uncertain' });
});
it('settings controls consume the real describe wrapper and keep native namespace CAS', async () => {
  const { adapter, writes } = controller(); const state = await adapter.nativeState('local') as { revision: string };
  const action = { type: 'settings-mutate', ns: 'known', ops: [{ op: 'set', path: ['model'], value: 'chosen' }], expectedRevision: 2, revision: state.revision };
  await expect(adapter.executeNativeControl('local', { ...action, expectedRevision: 3 })).rejects.toMatchObject({ code: 'native-control-rejected' });
  expect(writes).toEqual([]);
  await adapter.executeNativeControl('local', action);
  expect(writes).toContainEqual({ endpoint: 'settings/mutate', args: { ns: 'known', ops: action.ops, expectedRevision: 2 } });
});

it('preset and Forge requests require exact native evidence before the first turn, including after an idle completed turn', async () => {
  for (const options of [{}, { blank: false }, { blank: true, projectionBehind: true }]) {
    const { adapter, writes } = controller(options);
    const state = await adapter.nativeState('local') as { revision: string };
    for (const action of [{ type: 'preset', agentPreset: 'standard' }, { type: 'forge-worktree', from: null }, { type: 'forge-cancel' }]) {
      await expect(adapter.executeNativeControl('local', { ...action, revision: state.revision })).rejects.toMatchObject({ code: 'native-control-rejected', statusCode: 409 });
    }
    expect(writes).toEqual([]);
  }
  const ready = controller({ blank: true });
  const state = await ready.adapter.nativeState('local') as { revision: string };
  await ready.adapter.executeNativeControl('local', { type: 'preset', agentPreset: 'standard', revision: state.revision });
  expect(ready.writes).toEqual([{ endpoint: 'agentPresets/select', args: { agentId: 'native-parent', agentPreset: 'standard' } }]);
});

it('Forge preflight uses native editability and creation state instead of treating every idle Session as writable', async () => {
  for (const worktree of [{ editable: false, created: null, creation: null }, { editable: true, created: { path: 'already-created' }, creation: null }, { editable: true, created: null, creation: { running: true } }]) {
    const { adapter, writes } = controller({ blank: true, forge: { worktree } });
    const state = await adapter.nativeState('local') as { revision: string };
    await expect(adapter.executeNativeControl('local', { type: 'forge-worktree', from: null, revision: state.revision })).rejects.toMatchObject({ code: 'native-control-rejected', statusCode: 409 });
    expect(writes).toEqual([]);
  }
  const ready = controller({ blank: true, forge: { worktree: { editable: true, created: null, creation: null } } });
  const state = await ready.adapter.nativeState('local') as { revision: string };
  await ready.adapter.executeNativeControl('local', { type: 'forge-worktree', from: null, revision: state.revision });
  expect(ready.writes).toEqual([{ endpoint: 'forgePanel/requestWorktree', args: { sessionId: 'native-parent', from: null } }]);
});

it('a Host change during awaited preflight is rejected before the typed mutation dispatch', async () => {
  const { adapter, writes } = controller();
  const state = await adapter.nativeState('local') as { revision: string };
  vi.mocked(adapter.hostIdentity).mockResolvedValueOnce(host).mockResolvedValueOnce({ ...host, fingerprint: 'different-native-bootstrap' });
  await expect(adapter.executeNativeControl('local', { type: 'model', provider: 'one', model: 'same', revision: state.revision })).rejects.toMatchObject({ code: 'native-control-rejected', statusCode: 409 });
  expect(writes).toEqual([]);
});

it('catalog metadata distinguishes an idle started Session from a verified blank Session', () => {
  const forge = { worktree: { editable: true, created: null, creation: null } };
  const catalog = (blank: boolean) => dshNativeActionMetadata(true, { presets: { presets: [{ id: 'standard' }] }, forge,
    session: { state: { cursor: 4, active: true, running: false }, projections: { asOfSeq: 4, values: { sessionListMetadata: { blank } } } } });
  for (const type of ['preset', 'forge-worktree', 'forge-cancel']) {
    expect(catalog(false).find(action => action.type === type)).toMatchObject({ supported: false, requiresBlankSession: true });
    expect(catalog(true).find(action => action.type === type)).toMatchObject({ supported: true, requiresBlankSession: true });
  }
});
