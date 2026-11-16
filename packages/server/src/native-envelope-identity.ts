const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value : null;

/** Extract explicit native scope, never a Web owner or a subject mentioned by
 * a tool. Only unwrap the adapter/transport wrapper, not arbitrary payloads. */
export function nativeEnvelopeIdentity(agent: string, value: unknown): { nativeId: string | null; actorId: string | null; parentToolUseId: string | null } {
  const root = object(value);
  const native = object(root['native'] ?? root['frame'] ?? value);
  const params = object(native['params']);
  const result = object(native['result']);
  let nativeId = text(native['session_id']) ?? text(result['sessionId']);
  let actorId = text(native['actorId']) ?? text(native['agent_id']) ?? text(params['actorId']);
  if (agent === 'codex') {
    const scopedThread = text(params['threadId']) ?? (native['method'] === 'thread/started' ? text(object(params['thread'])['id']) : null);
    nativeId = scopedThread ?? nativeId ?? text(object(result['thread'])['id']);
    actorId ??= scopedThread;
  }
  if (agent === 'dsh') {
    const frame = object(native['value']);
    // The Gateway explicitly declares this as an Agent-scoped invocation.
    // Emit payloads, cancellations and RPC args do not prove such a scope.
    const scopedAgent = frame['type'] === 'waterfall' ? text(frame['agentId']) : null;
    nativeId = scopedAgent ?? nativeId;
    actorId ??= scopedAgent;
  }
  return { nativeId, actorId, parentToolUseId: text(native['parent_tool_use_id']) };
}
