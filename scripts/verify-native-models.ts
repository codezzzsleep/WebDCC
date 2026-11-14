/** Native catalog reference: no threads, turns, prompts or model requests. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { resolve } from 'node:path';
import { CodexAdapter, PINNED_VERSION } from '../packages/adapters/codex/src/adapter.js';
import { JsonRpcStdio } from '../packages/adapters/codex/src/rpc.js';
import { nativeRequest } from '../packages/adapters/codex/src/controls.js';
import type { Model } from '../packages/adapters/codex/src/schema/v2/Model.js';
import type { ModelListResponse } from '../packages/adapters/codex/src/schema/v2/ModelListResponse.js';
import { isolatedEnv } from '../packages/server/src/test-isolation.js';
import { sourceFingerprint } from './lib/gate-report.js';

const binaryIndex = process.argv.indexOf('--binary'); if (binaryIndex < 0 || !process.argv[binaryIndex + 1]) throw new Error('需要 --binary');
const binary = resolve(process.argv[binaryIndex + 1]!);
const isolated = isolatedEnv({ PATH: process.env['PATH'] }, 'wdcc-native-models');
const report = resolve('web_review/evidence/native-models-current.json');
const reference: Model[] = []; const methods: string[] = [];
const adapter = new CodexAdapter({ command: binary, env: isolated.env, traceSink: { record: frame => { if (frame.dir === 'out') methods.push(String((frame.frame as { method?: string }).method ?? '')); } } });
const rpc = JsonRpcStdio.start({ command: binary, args: ['app-server'], env: isolated.env });
const hash = createHash('sha256'); for await (const chunk of createReadStream(binary)) hash.update(chunk);
const evidence: Record<string, unknown> = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint: sourceFingerprint(),
  nativeBinarySha256: hash.digest('hex'), environment: { os: platform(), arch: arch(), node: process.version }, baseline: PINNED_VERSION, paidModel: false, passed: false };
try {
  assert.equal((await adapter.probe()).version, PINNED_VERSION);
  await nativeRequest(rpc, 'initialize', { clientInfo: { name: 'native-catalog-reference', title: null, version: '1' }, capabilities: null }); rpc.notify('initialized');
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const result: ModelListResponse = await nativeRequest(rpc, 'model/list', { cursor, limit: 100, includeHidden: false }); reference.push(...result.data); cursor = result.nextCursor; if (cursor === null) break;
  }
  assert.equal(cursor, null, 'reference catalog incomplete'); assert.ok(reference.length > 0, 'empty native catalog');
  const actual = await adapter.listModels();
  assert.deepEqual(actual.map(model => ({ id: model.id, label: model.label, efforts: model.reasoningEfforts, modalities: model.inputModalities })),
    reference.map(model => ({ id: model.model, label: model.displayName, efforts: model.supportedReasoningEfforts.map(option => option.reasoningEffort), modalities: model.inputModalities })));
  assert.ok(methods.every(method => ['initialize', 'initialized', 'model/list'].includes(method)), 'catalog read started native work');
  const providerName = 'Provider "one"\nmodel = "not-injected"';
  const spec = adapter.buildLaunchSpec({ sessionId: 'quoted-config', cwd: isolated.dirs.root, providerId: 'quoted', model: 'quoted "model"',
    provider: { id: 'quoted', name: providerName, baseUrl: 'http://127.0.0.1:1/v1', protocols: ['openai-responses'] } });
  const quoted = JsonRpcStdio.start({ command: binary, args: spec.args, env: isolated.env });
  try {
    await nativeRequest(quoted, 'initialize', { clientInfo: { name: 'quoted-config-reference', title: null, version: '1' }, capabilities: null }); quoted.notify('initialized');
    const observed = await nativeRequest(quoted, 'config/read', { includeLayers: false });
    assert.equal(observed.config.model, 'quoted "model"');
    assert.equal(observed.config.model_provider, 'wdcc_quoted');
    const providers = observed.config['model_providers'];
    assert.ok(providers !== null && typeof providers === 'object' && !Array.isArray(providers));
    const provider = providers['wdcc_quoted']; assert.ok(provider !== null && typeof provider === 'object' && !Array.isArray(provider));
    assert.equal(provider['name'], providerName);
    evidence['quotedConfigVerified'] = true;
  } finally { await quoted.kill(); }
  evidence['models'] = actual; evidence['methods'] = methods; evidence['passed'] = true;
} catch (error) { evidence['error'] = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally { await rpc.kill(); await rm(isolated.dirs.root, { recursive: true, force: true }); await mkdir(resolve(report, '..'), { recursive: true });
  await writeFile(report, `${JSON.stringify(evidence, null, 2)}\n`); process.stdout.write(`${JSON.stringify({ passed: evidence['passed'], error: evidence['error'], report })}\n`); }
