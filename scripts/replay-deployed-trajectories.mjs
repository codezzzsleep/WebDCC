/**
 * Re-run production adapter handlers over captured official native frames.
 * This command makes zero model requests. Original evidence is never rewritten.
 * Run with: pnpm exec tsx scripts/replay-deployed-trajectories.mjs <report.json>
 */
import assert from 'node:assert/strict';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.ts';
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.ts';
import { DshAdapter } from '../packages/adapters/dsh/src/adapter.ts';
import { claudeReplayContexts } from './lib/claude-replay-context.ts';
import { createRunIdentity } from './lib/gate-report.ts';

const path = process.argv[2];
assert(path, 'Supply one immutable captured real-run report');
const args = process.argv.slice(3);
let hostContextPath;
let outputPath;
for (let index = 0; index < args.length; index += 2) {
  assert(args[index + 1] && !args[index + 1].startsWith('--'), 'Replay options require a file path');
  if (args[index] === '--host-context') hostContextPath = args[index + 1];
  else if (args[index] === '--out') outputPath = args[index + 1];
  else throw new Error('Unknown replay option');
}
const bytes = await readFile(path);
const report = JSON.parse(bytes.toString());
const root = dirname(path);
const traceBytes = await readFile(join(root, report.trace.file));
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(hash(traceBytes), report.trace.sha256, 'Recorded trace digest changed');
assert.equal(report.trace.summary.incomplete, false, 'Incomplete traces cannot establish replay acceptance');
assert.equal(report.live, true, 'Controlled traces cannot be mislabeled as real model captures');
assert(report.requests.length > 0 && report.requests.every(request => request.state === 'completed'));
const rows = traceBytes.toString().split('\n').filter(Boolean).map(line => JSON.parse(line));
const nativeRows = rows.filter(row => row.source === 'native');
let replayRows = nativeRows;
let hostContext;
if (hostContextPath !== undefined) {
  assert.equal(report.agent, 'dsh', 'Host catalog context is specific to DSH');
  const contextBytes = await readFile(hostContextPath);
  const bounds = new Map();
  for (const row of nativeRows) {
    assert(typeof row.runId === 'string' && Number.isSafeInteger(row.seq), 'Native records lack capture-run/sequence identity');
    bounds.set(row.runId, Math.max(bounds.get(row.runId) ?? 0, row.seq));
  }
  const seen = new Set(nativeRows.map(row => `${row.runId}:${row.seq}`));
  const contextRows = contextBytes.toString().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const additional = contextRows.filter(row => {
    const through = bounds.get(row.runId);
    const transport = row.value?.frame?.dshTransport;
    return row.source === 'native' && row.channel === 'rpc:session/modelCatalog'
      && through !== undefined && Number.isSafeInteger(row.seq) && row.seq <= through
      && !seen.has(`${row.runId}:${row.seq}`)
      && (report.nativeHost?.fingerprint === undefined || transport?.verifiedHostFingerprint === report.nativeHost.fingerprint);
  });
  assert(additional.length > 0, 'No compatible original Host catalog context was supplied');
  replayRows = [...nativeRows, ...additional].sort((a, b) => a.at.localeCompare(b.at) || (a.runId === b.runId ? a.seq - b.seq : 0));
  hostContext = { sourceSha256: hash(contextBytes), catalogFrames: additional.length,
    catalogSha256: hash(additional.map(row => JSON.stringify(row)).join('\n') + '\n'),
    scope: 'Original same-run catalog RPC before native capture cutoff; no guessed or rewritten identities' };
}
const native = replayRows.map(row => row.value);
const mapped = rows.filter(row => row.source === 'mapped').map(row => row.value);
assert(native.length > 0 && mapped.length > 0, 'Both independent official frames and mapped production events are required');
const handlers = { codex: CodexAdapter, 'claude-code': ClaudeAdapter, dsh: DshAdapter };
assert(handlers[report.agent], 'Unknown native Agent');
let queryContexts, queryContextFailure;
try { if (report.agent === 'claude-code') queryContexts = claudeReplayContexts(rows); }
catch (error) { queryContextFailure = error instanceof Error ? error.message : String(error); }
const replay = queryContextFailure ? undefined : report.agent === 'claude-code' ? ClaudeAdapter.replay(report.sessionId, queryContexts[0]) : handlers[report.agent].replay(report.sessionId, report.nativeId);
const replayed = [];
let currentQuery;
for (const [index, frame] of (queryContextFailure ? [] : native).entries()) {
  if (queryContexts !== undefined) {
    const seq = replayRows[index].seq;
    const query = queryContexts.find(context => context.evidenceSequence < seq && seq <= context.throughSequence);
    assert(query, 'Missing preceding Claude query lifecycle identity');
    if (currentQuery !== query.queryId) {
      replay.feed({ i: frame.i, t: frame.t, dir: 'in', ch: 'claude-query-runtime', frame: query });
      currentQuery = query.queryId;
    }
  }
  replayed.push(...replay.feed(frame));
  await Promise.resolve();
}
const kinds = new Set(['assistant.message','reasoning','command','file.read','file.change','tool.call','usage','error']);
const timingFields = new Set(['durationMs', 'generationMs']);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !timingFields.has(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function projection(events) {
  const items = new Map();
  for (const event of events) {
    if (event.type === 'item.start' || event.type === 'item.complete') {
      items.set(event.itemKey, { kind: event.kind, data: JSON.parse(JSON.stringify(event.data)) });
    } else if (event.type === 'item.delta') {
      const item = items.get(event.itemKey);
      if (item) item.data[event.field] = String(item.data[event.field] ?? '') + event.append;
    } else if (event.type === 'item.update') {
      const item = items.get(event.itemKey);
      if (item) item.data = { ...item.data, ...event.data };
    }
  }
  return canonical([...items].filter(([, item]) => kinds.has(item.kind)));
}
const result = {
  formatVersion: 1, mode: 'offline replay of captured real official native behavior',
  sourceReportSha256: hash(bytes), traceSha256: hash(traceBytes), agent: report.agent,
  deployment: report.deployment, nativeVersions: report.nativeVersions, provider: report.provider,
  replayIdentity: createRunIdentity(),
  additionalModelRequests: 0, originalStatus: report.status, nativeFrames: native.length,
  originalNativeFrames: nativeRows.length, ...(queryContexts === undefined ? {} : { queryContext: { records: queryContexts, evidenceSha256: hash(JSON.stringify(queryContexts)), source: 'Captured independent runtime-start lifecycle records; output identities are not inferred or rewritten' } }), ...(hostContext === undefined ? {} : { hostContext }),
  originalProjection: projection(mapped), replayProjection: projection(replayed),
  identityNormalization: 'none; native tool/item/call IDs and event sequence are retained',
  excludedTimingFields: [...timingFields],
  scope: 'Production text/reasoning/tool/file/usage/error projection equality. Does not prove live Provider availability, timing, approval/answer delivery, UI reconnection or full NP-48 acceptance.',
  status: 'failed', verifiedAt: new Date().toISOString(),
};
try {
  if (queryContextFailure) throw new Error(queryContextFailure);
  const calls = new Map(), outcomes = new Map();
  for (const observation of native) {
    const frame = observation.frame;
    if (report.agent === 'dsh') {
      const event = frame?.value?.event;
      if (event?.type === 'tool/call') {
        let input = {}; try { input = JSON.parse(event.data.arguments); } catch { /* recorded invalid arguments stay invalid */ }
        calls.set(event.data.callId, { name: event.data.name, input });
      }
      if (event?.type === 'tool/result') {
        const message = event.data.message ?? {};
        outcomes.set(event.data.toolCallId ?? message.toolCallId, {
          failed: message.isError === true, output: (message.content ?? []).map(part => part.text ?? '').join(''),
          evidenceSha256: hash(JSON.stringify(event)),
        });
      }
    } else if (report.agent === 'claude-code') {
      for (const block of frame?.message?.content ?? []) {
        if (block.type === 'tool_use') calls.set(block.id, { name: block.name, input: block.input });
        if (block.type === 'tool_result') outcomes.set(block.tool_use_id, {
          failed: block.is_error === true, output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          evidenceSha256: hash(JSON.stringify(block)),
        });
      }
    }
  }
  result.nativeOutcomeCorrections = [];
  for (const [key, item] of result.originalProjection) {
    if (item.kind !== 'file.read' && item.kind !== 'file.change') continue;
    const id = key.startsWith('tool-') ? key.slice(5) : undefined;
    const outcome = outcomes.get(id); const call = calls.get(id);
    if (!outcome || !call) continue;
    const before = JSON.parse(JSON.stringify(item.data));
    if (item.kind === 'file.read') item.data = { ...item.data, status: outcome.failed ? 'failed' : 'completed', ...(outcome.failed ? { error: outcome.output } : {}) };
    else if (outcome.failed) item.data = { changes: [], status: 'failed', path: String(call.input.file_path ?? call.input.path ?? ''), error: outcome.output };
    if (JSON.stringify(before) !== JSON.stringify(item.data)) result.nativeOutcomeCorrections.push({ itemKey: key,
      nativeToolId: id, nativeOutcomeSha256: outcome.evidenceSha256, previousProjection: before, requiredNativeProjection: item.data,
      issue: outcome.failed ? item.kind === 'file.change' ? 138 : 140 : 'explicit successful read status',
    });
  }
  result.originalProjection = canonical(result.originalProjection);
  const actualUsage = result.replayProjection.filter(([, item]) => item.kind === 'usage');
  const originalUsage = result.originalProjection.filter(([, item]) => item.kind === 'usage');
  assert.equal(actualUsage.length, originalUsage.length, 'Usage event cardinality changed');
  assert.deepEqual(actualUsage, originalUsage, 'Original usage identities/content/order differ; complete original context is required');
  assert.deepEqual(result.replayProjection, result.originalProjection, 'Captured native frames and current production handler projections differ');
  result.status = 'passed';
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
}
const destination = outputPath ?? join(root, `replay-native-outcomes-${result.replayIdentity.runId}.json`);
await writeFile(destination, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
assert.deepEqual(await readFile(path), bytes, 'Original real-run report was modified');
process.stdout.write(JSON.stringify({ agent: report.agent, status: result.status, additionalModelRequests: 0,
  nativeFrames: native.length, report: destination, error: result.error?.slice(0, 500) }) + '\n');
