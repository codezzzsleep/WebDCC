import type { NativeTerminalResult, NativeTerminalResultsResponse, SessionDto, StoredEvent } from '@webdcc/protocol';
import { rebuildNativeTurnOutcomes, type NativeTurnOutcomeSource } from './native-turn-outcomes.js';
import { stableJsonDigest } from './stable-json-digest.js';

export interface NativeTerminalResultsOptions { maxRecords?: number; maxBytes?: number }
/** Bounded read model. It never applies a native result to the Web state. */
export function recoverNativeTerminalResults(source: NativeTurnOutcomeSource, session: SessionDto, events: StoredEvent[], options: NativeTerminalResultsOptions = {}): NativeTerminalResultsResponse {
  const maxRecords = options.maxRecords ?? 5000; const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 5000 || !Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 2 * 1024 * 1024) throw new Error('Invalid native terminal read budget');
  const recovery: NativeTerminalResultsResponse['recovery'] = { formatVersion: 1, scope: 'native-terminal-results', coverage: 'complete', throughEnvelopeId: 0, hasMore: false, issues: [], omittedIssues: 0, conflicts: [] };
  const issue = (id: number | null, reason: string) => { recovery.coverage = 'partial'; if (recovery.issues.length < 50) recovery.issues.push({ envelopeId: id, reason }); else recovery.omittedIssues++; };
  const boundary = session.conversation?.resetSeq ?? 0;
  const currentTurns = new Set(events.filter(event => event.seq > boundary && event.turnId !== null).map(event => event.turnId));
  const previousTurns = new Set(events.filter(event => event.seq <= boundary && event.turnId !== null).map(event => event.turnId));
  const byOutcome = new Map<string, NativeTerminalResult>(); const scopes = new Map<string, Set<string>>();
  const represented = new Set<string>();
  const signature = (outcomeId: string, payload: unknown) => stableJsonDigest({ scheme: 'native-terminal-publication-1', outcomeId,
    output: payload !== null && typeof payload === 'object' ? Object.fromEntries(Object.entries(payload).filter(([key]) => !['runtime', 'nativeTurnId', 'nativeSeq'].includes(key))) : payload });
  let after = 0; let count = 0; let bytes = 0;
  while (count < maxRecords) {
    const size = Math.min(500, maxRecords - count); const page = source.list(session.id, after, size + 1);
    if (page.length === 0) break;
    for (const row of page.slice(0, size)) {
      after = row.id; recovery.throughEnvelopeId = row.id; count++;
      if (row.source !== 'mapping' || row.direction !== 'in' || !['turn.end', 'item.complete'].includes(row.channel)) continue;
      let raw;
      try { raw = source.get(row.id); } catch { issue(row.id, 'native-terminal-payload-invalid'); continue; }
      if (raw === undefined) { issue(row.id, 'native-terminal-payload-missing'); continue; }
      const payload = raw.payload as { type?: unknown; kind?: unknown } | null;
      if (row.channel === 'item.complete' && payload !== null && typeof payload === 'object' && payload.kind !== 'turn.completed') continue;
      bytes += Buffer.byteLength(JSON.stringify(raw));
      if (bytes > maxBytes) { recovery.hasMore = true; issue(row.id, 'native-terminal-scan-size-limit'); break; }
      const decoded = rebuildNativeTurnOutcomes({ ...source, list: () => [row], get: () => raw }, { sessionId: session.id, limit: 1, maxBytes });
      const candidate = decoded.outcomes[0];
      if (candidate === undefined) { issue(row.id, decoded.records[0]?.reason ?? 'native-terminal-not-supported'); continue; }
      if (boundary > 0 && !currentTurns.has(candidate.publicTurnId)) {
        if (!previousTurns.has(candidate.publicTurnId)) issue(row.id, 'native-terminal-conversation-assignment-missing');
        continue;
      }
      const scope = scopes.get(candidate.scopeId) ?? new Set<string>(); scope.add(candidate.outcomeId); scopes.set(candidate.scopeId, scope);
      const published = events.find(event => event.kind === 'turn.completed' && event.turnId === candidate.publicTurnId && event.nativeEnvelopeId === row.id);
      if (published !== undefined) {
        if ((published.data as { status?: unknown }).status === candidate.status) { represented.add(signature(candidate.outcomeId, raw.payload)); continue; }
        issue(row.id, 'native-semantic-terminal-conflict');
      }
      const existing = byOutcome.get(candidate.outcomeId);
      if (existing === undefined) byOutcome.set(candidate.outcomeId, candidate);
      else { existing.origins.push(...candidate.origins); if (candidate.assignments !== undefined) (existing.assignments ??= []).push(...candidate.assignments); }
      if (Buffer.byteLength(JSON.stringify([...byOutcome.values()])) > maxBytes) { recovery.hasMore = true; issue(row.id, 'native-terminal-output-size-limit'); break; }
    }
    if (recovery.hasMore || page.length <= size) break;
  }
  if (count === maxRecords && source.list(session.id, after, 1).length > 0) { recovery.hasMore = true; issue(null, 'native-terminal-record-limit'); }
  for (const [scopeId, values] of scopes) if (values.size > 1) { recovery.conflicts.push({ scopeId, outcomeIds: [...values] }); issue(null, 'contradictory-native-outcomes'); }
  // An unread suffix could contradict any retained result. Expose the limit
  // instead of presenting that prefix as the full native terminal history.
  const outcomes = recovery.hasMore ? [] : [...byOutcome.values()].filter(item => {
    item.origins = item.origins.filter(origin => !represented.has(signature(item.outcomeId, origin.payload)));
    const ids = new Set(item.origins.map(origin => origin.id));
    if (item.assignments !== undefined) item.assignments = item.assignments.filter(assignment => ids.has(assignment.envelopeId));
    return item.origins.length > 0;
  });
  if (Buffer.byteLength(JSON.stringify({ outcomes, recovery })) > maxBytes) { outcomes.length = 0; recovery.conflicts = []; issue(null, 'native-terminal-output-size-limit'); }
  return { outcomes, recovery };
}
