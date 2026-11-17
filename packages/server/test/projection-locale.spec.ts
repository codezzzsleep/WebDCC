import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FakeAdapter } from '@webdcc/fake-adapter';
import type { AdapterEvent, NativeEnvelopeDetail, StoredEvent } from '@webdcc/protocol';
import type { Db } from '../src/db.js';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

const run = promisify(execFile);
interface Result { locale: string; mappings: { id: number; duplicate: boolean; unverified?: boolean }[]; events: StoredEvent[];
  observations: NativeEnvelopeDetail[]; projections: { event_key: string; envelope_id: number; event_seq: number | null }[] }
async function worker(file: string, mode: string, locale: string): Promise<Result> {
  const { stdout } = await run(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'fixtures/projection-locale.ts'), file, mode],
    { env: { ...process.env, LANG: locale, LC_ALL: locale }, timeout: 20_000 });
  return JSON.parse(stdout) as Result;
}
async function evidence(name: string, value: unknown): Promise<void> {
  const directory = process.env['WDCC_PROJECTION_LOCALE_EVIDENCE_DIR'];
  if (directory !== undefined) await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + '\n');
}
async function scenario(mode: string, retry: string = 'retry'): Promise<{ first: Result; second: Result }> {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-projection-locale-'));
  try {
    const first = await worker(join(directory, 'db.sqlite'), mode, 'en_US.UTF-8');
    const second = await worker(join(directory, 'db.sqlite'), retry, 'sv_SE.UTF-8');
    await evidence(`${mode}-${retry}`, { first, second }); return { first, second };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

it.each(['first', 'seed-canonical', 'seed-runtime'])('%s completion survives actual locale change and ten SQLite replays without duplicate semantics', async mode => {
  const { first, second } = await scenario(mode);
  expect(first.locale).toBe('en-US'); expect(second.locale).toBe('sv-SE');
  expect(second.events).toEqual(first.events); expect(second.observations).toHaveLength(11);
  expect(second.mappings.every(result => result.duplicate && !result.unverified)).toBe(true);
  if (mode.startsWith('seed-')) expect(second.projections).toContainEqual(first.projections[0]);
});

it.each(['seed-redacted', 'seed-missing', 'seed-future'])('%s legacy identity remains explicit unverified without inventing a semantic duplicate', async mode => {
  const { first, second } = await scenario(mode);
  expect(second.events).toEqual(first.events); expect(second.projections).toContainEqual(first.projections[0]);
  expect(second.mappings.every(result => result.unverified && !result.duplicate)).toBe(true);
  expect(second.observations.slice(1).every(row => row.disposition === 'legacy-projection-unverified')).toBe(true);
});

it('different legacy content remains distinct despite identical native coordinates', async () => {
  const { first, second } = await scenario('seed-canonical', 'different');
  expect(second.events).toHaveLength(2); expect(second.events[0]).toEqual(first.events[0]);
  expect(second.mappings[0]).toMatchObject({ duplicate: false }); expect(second.mappings[0]?.unverified).not.toBe(true);
});

it('unverified projection skips matching hot output without disposing the native writer or changing its accepted input', async () => {
  const ctx = await createTestApp(); const adapter = new FakeAdapter({ id: 'claude-code' }); let receive!: (id: string, event: AdapterEvent) => void;
  adapter.onEvent = callback => { receive = callback; }; let disposals = 0; const dispose = adapter.dispose.bind(adapter);
  adapter.dispose = async id => { disposals++; await dispose(id); }; adapter.send = async () => undefined; ctx.manager.registerAdapter(adapter);
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'claude-code'); const runtime = ctx.manager.getRuntime(sessionId)!;
    ctx.store.journal.claim({ op: 'send', clientCommandId: 'kept-native-input', sessionId, text: 'kept original input' });
    await ctx.manager.send(sessionId, { text: 'kept original input' }, 'kept-native-input');
    const event: Extract<AdapterEvent, { type: 'item.complete' }> = { type: 'item.complete', itemKey: 'controlled-tool', kind: 'tool.call', nativeSeq: 10,
      data: { name: 'controlled', input: { 'ä': 'first', z: 'second' }, status: 'completed' }, native: { type: 'tool_use', session_id: runtime.nativeId }, runtime: runtime.identity };
    receive(sessionId, event); const original = ctx.store.allEvents(sessionId);
    const source = original.find(value => value.kind === 'tool.call')!;
    const db = (ctx.store as unknown as { db: Db }).db;
    db.prepare('UPDATE native_event_projections SET event_key = ? WHERE envelope_id = ?').run('native-future-format:unknown', source.nativeEnvelopeId!);
    const owner = ctx.store.nativeOwners.get(sessionId); const queue = ctx.store.journal.queue(sessionId);
    expect(queue[0]?.state).toBe('native-accepted');
    receive(sessionId, { ...event, type: 'item.start' }); receive(sessionId, event);
    await evidence('manager-unverified', { before: original, after: ctx.store.allEvents(sessionId), ownerBefore: owner, ownerAfter: ctx.store.nativeOwners.get(sessionId),
      queueBefore: queue, queueAfter: ctx.store.journal.queue(sessionId), disposals, observations: ctx.store.nativeEvents.list(sessionId) });
    expect(ctx.store.allEvents(sessionId)).toEqual(original); expect(disposals).toBe(0);
    expect(ctx.store.nativeOwners.get(sessionId)).toEqual(owner); expect(ctx.store.journal.queue(sessionId)).toEqual(queue);
    expect(runtime.hot.size).toBe(0); expect(ctx.store.nativeEvents.list(sessionId).at(-1)?.disposition).toBe('legacy-projection-unverified');
  } finally { await ctx.close(); }
});
