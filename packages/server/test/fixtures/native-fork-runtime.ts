import { createHash } from 'node:crypto';
import type { AgentAdapter, AgentId, ClaudeQueryConfiguration, CreateOpts, NativeForkSession, UserInput } from '@webdcc/protocol';
import { FakeAdapter } from '@webdcc/fake-adapter';

/** Controlled producer for HTTP/browser recovery tests, not native acceptance. */
export function nativeForkFixture(agent: AgentId, cwd: string, sourceNativeId = 'native-source') {
  const fake = new FakeAdapter({ id: agent });
  const adapter: AgentAdapter = fake;
  const creates: CreateOpts[] = [];
  const resumes: (CreateOpts & { nativeId: string })[] = [];
  const sends: { sessionId: string; input: UserInput }[] = [];
  const nativeIds = new Map<string, string>();
  const create = fake.create.bind(fake); const resume = fake.resume.bind(fake); const send = fake.send.bind(fake);
  let forkCalls = 0;
  const options = { thinking: { type: 'adaptive' as const }, enableFileCheckpointing: true };
  const configuration: ClaudeQueryConfiguration = { formatVersion: 1, queryId: 'source-query', nativeSessionId: sourceNativeId,
    sdkVersion: '0.3.322', cliVersion: '2.1.322', scopeFingerprint: '0'.repeat(64), requestedModel: 'fixture', options,
    optionsFingerprint: createHash('sha256').update(JSON.stringify(options)).digest('hex'), nativeAcceptedAt: '2026-11-25T20:00:00Z', modelEffect: 'not-observed' };
  adapter.create = async opts => { creates.push(opts); return create(opts); };
  adapter.resume = async opts => { resumes.push(opts); nativeIds.set(opts.sessionId, opts.nativeId); await resume(opts); };
  adapter.send = async (sessionId, input) => { sends.push({ sessionId, input: structuredClone(input) }); await send(sessionId, input); };
  adapter.listModels = async () => [{ id: 'fixture', label: 'Fixture model', isDefault: true, inputModalities: ['text', 'image'] }];
  adapter.nativeState = sessionId => ({ nativeId: nativeIds.get(sessionId) ?? sourceNativeId, turnActive: false, revision: 'controlled-fork-state' });
  adapter.nativeCatalog = async () => ({ actions: [{ type: 'fork', label: '分叉原生会话', supported: true, requiresIdle: true,
    schema: { type: 'object', properties: {}, additionalProperties: false } }] });
  let descriptor: NativeForkSession | undefined;
  adapter.executeNativeControl = async (_id, action) => {
    if ((action as { type?: string }).type !== 'fork') throw new Error('Unexpected fixture action');
    forkCalls++;
    const nativeFork: NativeForkSession = descriptor ?? { sourceNativeId, nativeId: `native-fork-${forkCalls}`, cwd, model: 'fixture',
      ...(agent === 'codex' ? { accessMode: 'inherit', reasoningEffort: null } : {}),
      ...(agent === 'claude-code' ? { claudeConfiguration: configuration } : {}) };
    return { id: nativeFork.nativeId, nativeFork, originalNativeResult: { sessionId: nativeFork.nativeId } };
  };
  return { adapter, creates, resumes, sends, configuration, forkCalls: () => forkCalls, descriptor: (value: NativeForkSession) => { descriptor = value; } };
}
