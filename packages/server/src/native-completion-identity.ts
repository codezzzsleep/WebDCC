import type { AdapterEvent } from '@webdcc/protocol';

interface Context { sessionId: string; agent: string; nativeId?: string }
type Completion = Extract<AdapterEvent, { type: 'item.complete' }>;

/** The observed native scope survives a runtime binding change. Keep the old
 * input forms for verified committed aliases, without rewriting old keys. */
export function nativeCompletionIdentity(context: Context, event: Completion, observedNativeId: string | null): { canonical: unknown; legacy: unknown[] } {
  const common = { sessionId: context.sessionId, seq: event.nativeSeq, kind: event.kind,
    itemKey: event.itemKey, turnId: event.nativeTurnId, data: event.data };
  const runtime = (nativeId: string | undefined): unknown => ({ ...common, nativeId });
  if (observedNativeId === null || observedNativeId === '') return { canonical: runtime(context.nativeId), legacy: [] };
  return {
    canonical: { ...common, nativeId: observedNativeId, agent: context.agent, identityScheme: 'native-completion-scope-1' },
    legacy: [runtime(context.nativeId), runtime(observedNativeId), runtime(''), runtime(undefined)],
  };
}
