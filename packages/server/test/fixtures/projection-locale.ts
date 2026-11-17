import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { payloadHash } from '../../src/command-journal.js';
import { nativeCompletionIdentity } from '../../src/native-completion-identity.js';
import type { AdapterEvent } from '@webdcc/protocol';

const db = openDb(process.argv[2]!); const mode = process.argv[3]!; const store = new Store(db);
try {
  let sessionId = (db.prepare('SELECT id FROM sessions LIMIT 1').get() as { id: string } | undefined)?.id;
  if (sessionId === undefined) {
    const workspace = store.createWorkspace('controlled projection locale', '/tmp');
    sessionId = store.createSession({ workspaceId: workspace.id, agent: 'claude-code' }).id;
  }
  const context = { sessionId, agent: 'claude-code', nativeId: 'native-locale-session' };
  const event: Extract<AdapterEvent, { type: 'item.complete' }> = { type: 'item.complete', kind: 'tool.call', itemKey: 'native-tool-use', nativeSeq: 10,
    data: { name: 'controlled-json-tool', input: { 'ä': mode === 'different' ? 'different' : 'first', z: 'second' }, status: 'completed', output: 'controlled result' },
    native: { type: 'tool_use', session_id: context.nativeId, id: 'native-tool-use' } };
  const mappings: { id: number; duplicate: boolean; unverified?: boolean }[] = [];
  for (let i = 0; i < (mode === 'retry' ? 10 : 1); i++) {
    const result = store.nativeEvents.mapping(context, event, 'accepted') as typeof mappings[number]; mappings.push(result);
    if (!result.duplicate && !result.unverified) store.appendEvent({ sessionId, turnId: null, itemKey: event.itemKey, kind: event.kind,
      data: event.data, native: event.native, nativeSeq: event.nativeSeq, nativeEnvelopeId: result.id });
  }
  if (mode.startsWith('seed-')) {
    const mapping = mappings[0]!;
    const identity = nativeCompletionIdentity(context, event, context.nativeId);
    const legacy = mode === 'seed-runtime' ? nativeCompletionIdentity({ ...context, nativeId: '' }, event, context.nativeId).legacy[0] : identity.canonical;
    const key = mode === 'seed-future' ? 'native-future-format:unknown' : payloadHash(legacy);
    db.prepare('UPDATE native_event_projections SET event_key = ? WHERE envelope_id = ?').run(key, mapping.id);
    if (mode === 'seed-redacted' || mode === 'seed-missing') db.prepare('UPDATE native_event_envelopes SET payload = ?, payload_coverage = ? WHERE id = ?')
      .run(mode === 'seed-redacted' ? JSON.stringify({ omitted: 'sensitive-native-request' }) : '{}', mode === 'seed-redacted' ? 'restricted' : 'unavailable', mapping.id);
  }
  process.stdout.write(JSON.stringify({ locale: Intl.Collator().resolvedOptions().locale, mode, mappings, events: store.allEvents(sessionId),
    observations: store.nativeEvents.list(sessionId).map(row => store.nativeEvents.get(row.id)), projections: db.prepare('SELECT * FROM native_event_projections').all() }) + '\n');
} finally { db.close(); }
