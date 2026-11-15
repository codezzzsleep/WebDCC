import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelProxy } from '@webdcc/model-proxy';
import { FakeAdapter } from '@webdcc/fake-adapter';
import { InteractionRecorder } from '../src/interaction-recorder.js';
import { ModelRecording } from '../src/model-recording.js';
import { start, type RunningServer } from '../src/main.js';
import { createTestApp } from './helpers.js';

let root: string | undefined;
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (root !== undefined) await rm(root, { recursive: true, force: true }); root = undefined; });

it('NP-14 failed observer route setup retains the original native Provider and records the coverage failure', async () => {
  root = await mkdtemp(join(tmpdir(), 'wdcc-model-observer-'));
  const recorder = new InteractionRecorder(root); await recorder.init();
  vi.spyOn(ModelProxy.prototype, 'listen').mockRejectedValue(new Error('observer unavailable'));
  const recording = new ModelRecording(recorder);
  const opts = { sessionId: 's', cwd: root, providerId: 'fixture', provider: { id: 'fixture', name: 'fixture', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture-secret', protocols: ['openai-responses'] } };
  const result = await recording.prepare(opts, 'codex');
  expect(result.provider).toEqual(opts.provider);
  expect(result.recordingEndpoint).toBeUndefined();
  expect(result.traceSink).toBeDefined();
  expect(await recorder.summary('s')).toMatchObject({ incomplete: true });
  await recording.close('s');
});

it('NP-14 an unavailable diagnostic directory does not prevent an isolated server from starting', async () => {
  const ctx = await createTestApp();
  let server: RunningServer | undefined;
  try {
    await writeFile(join(ctx.dataDir, 'traces'), 'not a directory');
    vi.stubEnv('WDCC_TEST_HOOKS', '0');
    server = await start({ ...ctx.config, recordInteractions: true }, { adapters: [new FakeAdapter()], webDist: root });
    expect(server.recorder).toBeUndefined();
    const response = await fetch(server.url);
    expect(response.status).toBeLessThan(500);
  } finally { await server?.close(); await ctx.close(); }
});
