import { observeUsage, selectTurnUsage, type CodexUsageHistory, type SessionDto, type SessionUsageResponse, type UsageEvent, type UsageObservation } from '@webdcc/protocol';
import type { Db } from './db.js';

interface UsageRow {
  turn_id: string;
  item_key: string;
  kind: UsageEvent['kind'];
  at: string;
  usage: string | null;
  native_usage: string | null;
  codex_usage: string | null;
  native_type: string | null;
  native_thread: string | null;
}

export function readSessionUsage(db: Db, session: SessionDto): SessionUsageResponse {
  const boundary = session.conversation;
  const resetSeq = boundary?.resetSeq ?? 0;
  const previousNative = session.nativeId !== undefined && boundary?.previousNativeId !== session.nativeId ? boundary?.previousNativeId : undefined;
  // Read just the accounting fields and turn markers through the session's
  // durable cursor. In particular, do not materialize tool output or result text.
  const rows = db.prepare(`SELECT turn_id, kind, at, item_key,
      CASE kind WHEN 'usage' THEN data WHEN 'turn.completed' THEN json_extract(data, '$.usage') END AS usage,
      CASE WHEN kind IN ('usage', 'turn.completed') THEN json_extract(native, '$.usage') END AS native_usage,
      CASE WHEN kind = 'usage' THEN json_extract(native, '$.tokenUsage') END AS codex_usage,
      CASE WHEN kind IN ('usage', 'turn.completed') THEN json_extract(native, '$.type') END AS native_type,
      CASE WHEN kind = 'usage' THEN json_extract(native, '$.threadId') END AS native_thread
    FROM events WHERE session_id = ? AND seq > ? AND seq <= ?
      AND kind IN ('user.message', 'turn.started', 'turn.completed', 'usage')
      AND (? IS NULL OR json_extract(native, '$.session_id') IS NOT ?)
    ORDER BY seq`).iterate(session.id, resetSeq, session.lastSeq, previousNative ?? null, previousNative ?? null) as Iterable<UsageRow>;

  const turns = new Map<string, UsageObservation[]>();
  const codexTotals: CodexUsageHistory = new Map();
  for (const row of rows) {
    if (row.turn_id === '' && row.kind !== 'usage') continue;
    const usage = row.usage === null ? undefined : JSON.parse(row.usage) as UsageEvent['data'];
    const sample = observeUsage({
      kind: row.kind, at: row.at, itemKey: row.item_key, data: (row.kind === 'turn.completed' ? { usage } : usage ?? {}) as UsageEvent['data'],
      native: { type: row.native_type, threadId: row.native_thread,
        usage: row.native_usage === null ? undefined : JSON.parse(row.native_usage),
        tokenUsage: row.codex_usage === null ? undefined : JSON.parse(row.codex_usage) },
    }, codexTotals, session.agent);
    if (sample === undefined && row.kind === 'usage') continue;
    let observations = turns.get(row.turn_id);
    if (observations === undefined) {
      observations = [];
      turns.set(row.turn_id, observations);
    }
    if (sample !== undefined) observations.push(sample);
  }

  let totalTokens: number | undefined;
  let partial = false;
  for (const [turnId, observations] of turns) {
    const selected = selectTurnUsage(observations);
    partial ||= selected.length === 0 || selected.some(sample => sample.partial) ||
      (turnId === '' && selected.some(sample => sample.usage.scope !== 'attempt'));
    for (const { tokens } of selected) {
      if (tokens === undefined) continue;
      const next: number = (totalTokens ?? 0) + tokens;
      if (Number.isSafeInteger(next)) totalTokens = next;
      else partial = true;
    }
  }
  return { throughSeq: session.lastSeq, resetSeq, totalTokens, partial };
}
