import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const run = promisify(execFile);
interface Result { locale: string; created?: boolean; conflict?: boolean; identityUnverified?: boolean;
  record: { payloadHash: string; payload: { answer?: unknown }; state: string; result?: unknown };
  executions?: number; result?: { ok: boolean; code?: string; value?: unknown } }
async function worker(file: string, mode: string, locale: string, changed = false): Promise<Result> {
  const { stdout } = await run(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'fixtures/command-digest-locale.ts'), file, mode, ...(changed ? ['different'] : [])],
    { env: { ...process.env, LANG: locale, LC_ALL: locale }, timeout: 20_000 });
  return JSON.parse(stdout) as Result;
}
async function scenario(name: string, fn: (file: string) => Promise<unknown>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-command-locale-'));
  try {
    const report = await fn(join(directory, 'db.sqlite'));
    const evidence = process.env['WDCC_COMMAND_DIGEST_EVIDENCE_DIR'];
    if (evidence !== undefined) await writeFile(join(evidence, `${name}.json`), JSON.stringify(report, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

it('fresh command identity survives a real Node locale change and SQLite reopen', async () => {
  let first!: Result; let second!: Result;
  await scenario('new-command', async file => {
    first = await worker(file, 'claim', 'en_US.UTF-8'); second = await worker(file, 'claim', 'sv_SE.UTF-8'); return { first, second };
  });
  expect(first.locale).toBe('en-US'); expect(second.locale).toBe('sv-SE');
  expect(first.created).toBe(true); expect(second.created).toBe(false); expect(second.conflict).toBe(false);
  expect(second.record).toEqual(first.record);
});

it('new secret command identity is stable while its persisted answer remains omitted', async () => {
  let first!: Result; let second!: Result;
  await scenario('new-secret', async file => {
    first = await worker(file, 'secret', 'en_US.UTF-8'); second = await worker(file, 'secret', 'sv_SE.UTF-8'); return { first, second };
  });
  expect(second.conflict).toBe(false); expect(second.record.payloadHash).toBe(first.record.payloadHash);
  expect(first.record.payload.answer).toEqual({ omitted: 'sensitive-answer' });
  expect(second.record.payload.answer).toEqual({ omitted: 'sensitive-answer' });
});

it('complete legacy payload proves identical content across locale without overwriting its digest or receipt', async () => {
  let first!: Result; let second!: Result;
  await scenario('legacy-complete', async file => {
    first = await worker(file, 'seed-plain', 'en_US.UTF-8'); second = await worker(file, 'claim', 'sv_SE.UTF-8'); return { first, second };
  });
  expect(second.conflict).toBe(false); expect(second.identityUnverified).not.toBe(true); expect(second.record).toEqual(first.record);
});

it('a different legacy complete payload still conflicts across locale', async () => {
  let second!: Result;
  await scenario('legacy-different', async file => {
    const first = await worker(file, 'seed-plain', 'en_US.UTF-8'); second = await worker(file, 'claim', 'sv_SE.UTF-8', true); return { first, second };
  });
  expect(second.conflict).toBe(true);
});

it('a redacted legacy payload with an unmatched digest is unverifiable and never invites execution', async () => {
  let first!: Result; let claim!: Result; let dispatched!: Result;
  await scenario('legacy-redacted', async file => {
    first = await worker(file, 'seed-redacted', 'en_US.UTF-8'); claim = await worker(file, 'claim', 'sv_SE.UTF-8'); dispatched = await worker(file, 'dispatch', 'sv_SE.UTF-8');
    return { first, claim, dispatched };
  });
  expect(claim.identityUnverified).toBe(true); expect(claim.conflict).toBe(false);
  expect(dispatched.result).toMatchObject({ ok: false, code: 'uncertain' }); expect(dispatched.executions).toBe(0);
  expect(dispatched.record).toEqual(first.record);
});

it('dispatcher reuses a complete legacy receipt across locale without executing the action', async () => {
  let first!: Result; let dispatched!: Result;
  await scenario('legacy-dispatch', async file => {
    first = await worker(file, 'seed-plain', 'en_US.UTF-8'); dispatched = await worker(file, 'dispatch', 'sv_SE.UTF-8'); return { first, dispatched };
  });
  expect(dispatched.result).toEqual(first.record.result); expect(dispatched.executions).toBe(0); expect(dispatched.record).toEqual(first.record);
});

it('an unknown digest version is explicit uncertainty even if a payload is available', async () => {
  let first!: Result; let dispatched!: Result;
  await scenario('future-version', async file => {
    first = await worker(file, 'seed-future', 'en_US.UTF-8'); dispatched = await worker(file, 'dispatch', 'sv_SE.UTF-8'); return { first, dispatched };
  });
  expect(dispatched.result).toMatchObject({ ok: false, code: 'uncertain' }); expect(dispatched.executions).toBe(0);
  expect(dispatched.record).toEqual(first.record);
});
