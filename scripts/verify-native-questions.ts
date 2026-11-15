/** Actual pinned Harness -> HTTP/WebSocket -> Chromium -> native answer.
 * The loopback model only schedules native tools; it never substitutes an
 * adapter, SDK, request handler or browser. Homes and configuration are isolated. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect, type Browser } from '@playwright/test';
import type { AgentAdapter, AgentId, EventData, TraceFrame } from '../packages/protocol/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { ClaudeAdapter, resolveNativeCli } from '../packages/adapters/claude/src/adapter.js';
import { DshAdapter } from '../packages/adapters/dsh/src/adapter.js';
import { createSourceTestApp, observeSessionSnapshots } from '../browser-tests/helpers.js';
import { isolatedEnv } from '../packages/server/src/test-isolation.js';
import { startResponsesMock } from '../packages/testing/mock-models/src/responses-server.js';
import { startAnthropicMock } from '../packages/testing/mock-models/src/anthropic-server.js';
import { MockControl } from '../packages/testing/mock-models/src/mock-control.js';
import type { Plan } from '../packages/testing/mock-models/src/plan.js';
import { sourceFingerprint } from './lib/gate-report.js';

const option = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const binary = resolve(option('--binary') ?? '.artifacts/native-baseline/package/vendor/x86_64-unknown-linux-musl/bin/codex');
const reportPath = resolve(option('--report') ?? 'web_review/evidence/native-questions.json');
const requested = option('--case');
const cases = ['codex-plan', 'codex-default', 'claude', 'dsh', 'codex-plan-cancel', 'claude-cancel', 'dsh-cancel'] as const;
if (requested !== undefined && !cases.includes(requested as typeof cases[number])) throw new Error('Unknown --case');
const selectedCases = cases.filter(name => requested === undefined || name === requested);
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceFingerprint: sourceFingerprint(), expectedCases: selectedCases, kind: 'pinned-native-harness-with-loopback-scripted-model-and-chromium', paidModel: false, results: [], passed: false };
await mkdir(resolve(reportPath, '..'), { recursive: true });

for (const name of selectedCases) {
  const agent: AgentId = name.startsWith('codex') ? 'codex' : name.startsWith('claude') ? 'claude-code' : 'dsh';
  const isolated = isolatedEnv({ PATH: process.env['PATH'] }, 'wdcc-native-question');
  const workspacePath = join(isolated.dirs.root, 'workspace'); await mkdir(workspacePath);
  const freeText = '  原生自由答案 中文  ';
  const prompts = ['Which language?', 'Which features?'];
  const questions = prompts.map((question, index) => ({ id: 'q' + index, header: index === 0 ? 'Language' : 'Features', question,
    options: [{ label: 'Alpha', description: 'First choice' }, { label: 'Beta', description: 'Second choice' }],
    ...(agent === 'codex' ? { isOther: true, isSecret: false } : agent === 'dsh' ? { multi_select: index === 1 } : { multiSelect: index === 1 }) }));
  const expectedText = name + ': native answer acknowledged';
  const plan: Plan = [{ tool: { kind: 'ask', input: { questions }, ...(agent === 'claude-code' ? { name: 'AskUserQuestion' } : {}) } }, { text: expectedText }];
  const control = new MockControl(plan, '');
  const model = agent === 'codex' ? await startResponsesMock({ plan, control, log: () => undefined }) : await startAnthropicMock({ plan, control, log: () => undefined });
  const frames: TraceFrame[] = [];
  const traceSink = { record: (frame: TraceFrame): void => { frames.push(structuredClone(frame)); } };
  const env = Object.fromEntries(Object.entries(isolated.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const ctx = await createSourceTestApp(); let browser: Browser | undefined; let adapter: AgentAdapter | undefined;
  const result: Record<string, unknown> = { case: name, agent, passed: false, startedAt: new Date().toISOString() };
  result['configurationFingerprint'] = createHash('sha256').update(JSON.stringify({ env, agent, name, modelUrl: model.url, questions })).digest('hex');
  try {
    if (agent === 'codex') {
      assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), 'codex-cli 0.167.0');
      result['binarySha256'] = createHash('sha256').update(await readFile(binary)).digest('hex');
      const overrides = ['model_provider=wdcc_mock', 'model="mock-responses-1"', 'model_providers.wdcc_mock.name="WDCC isolated mock"',
        'model_providers.wdcc_mock.base_url="' + model.url + '/v1"', 'model_providers.wdcc_mock.wire_api="responses"', 'model_providers.wdcc_mock.env_key="WDCC_MOCK_KEY"',
        'model_providers.wdcc_mock.request_max_retries=0', 'model_providers.wdcc_mock.stream_max_retries=0'];
      adapter = new CodexAdapter({ command: binary, configOverrides: overrides, env: { ...env, WDCC_MOCK_KEY: 'fixture-only' }, traceSink });
    } else if (agent === 'claude-code') {
      const cli = resolveNativeCli(); assert.ok(cli, 'Pinned Claude CLI missing');
      assert.ok(execFileSync(cli, ['--version'], { encoding: 'utf8' }).includes('2.1.322'));
      result['binarySha256'] = createHash('sha256').update(await readFile(cli)).digest('hex');
      adapter = new ClaudeAdapter({ env: { ...env, ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: 'fixture-only' }, model: 'mock-anthropic-1', traceSink });
    } else {
      assert.equal(execFileSync('dsh', ['--version'], { encoding: 'utf8' }).trim(), '0.2.2-rc.1');
      // Port zero delegates allocation to the isolated native listener.
      adapter = new DshAdapter({ port: 0, env: { ...env, DEEPSEEK_BASE_URL: model.url, DEEPSEEK_API_KEY: 'fixture-only' }, traceSink });
    }
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Native questions ' + name, workspacePath);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent });
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address(); assert.ok(address && typeof address !== 'string');
    const base = 'http://127.0.0.1:' + address.port;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const through = observeSessionSnapshots(page, session.id);
    await page.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
    await page.goto(base + '/s/' + session.id);
    if (agent === 'codex') {
      const selector = page.getByTestId('codex-input-mode');
      await expect(selector.locator('option[value="plan"]')).toBeEnabled({ timeout: 15_000 });
      await selector.selectOption(name === 'codex-default' ? 'default' : 'plan');
    }
    const inputText = '  Ask the configured questions. 中文  ';
    await page.getByTestId('composer-input').fill(inputText);
    await page.getByTestId('send-button').click();
    const events = (): ReturnType<typeof ctx.store.allEvents> => ctx.store.allEvents(session.id);
    if (name === 'codex-default') {
      await expect.poll(() => events().filter(event => event.kind === 'turn.completed').length, { timeout: 30_000 }).toBe(1);
      assert.equal(events().filter(event => event.kind === 'question').length, 0);
      assert.ok(JSON.stringify(control.requests.map(request => request.body)).includes('unavailable in Default mode'), 'Native must report its Default-mode question limitation');
      result['outcome'] = 'native-default-question-unavailable-with-feature-defaults';
    } else if (name.endsWith('-cancel')) {
      await expect.poll(() => events().filter(event => event.kind === 'question').length, { timeout: 35_000 }).toBe(2);
      assert.equal(ctx.manager.getRuntime(session.id)?.status, 'waiting');
      await page.getByTestId('stop-button').click();
      await expect.poll(() => events().filter(event => event.kind === 'turn.completed').length, { timeout: 15_000 }).toBe(1);
      await expect.poll(() => page.locator('[data-testid="question-card"][data-state="pending"]').count(), { timeout: 10_000 }).toBe(0);
      assert.equal((events().findLast(event => event.kind === 'turn.completed')!.data as EventData['turn.completed']).status, 'interrupted');
      const before = frames.filter(frame => frame.dir === 'out').length;
      await page.reload(); await expect(page.getByTestId('composer-input')).toBeVisible();
      await expect.poll(() => through(), { timeout: 10_000 }).toBeDefined();
      assert.equal(await page.locator('[data-testid="question-card"][data-state="pending"]').count(), 0);
      result['cancelReplies'] = frames.filter(frame => frame.dir === 'out').slice(0, before);
      result['outcome'] = 'native-interrupt-cancels-pending-questions-and-reload-remains-ended';
    } else {
      await expect.poll(() => events().filter(event => event.kind === 'question').length, { timeout: 35_000 }).toBe(2);
      assert.equal(ctx.manager.getRuntime(session.id)?.status, 'waiting');
      assert.equal(events().filter(event => event.kind === 'turn.completed').length, 0);
      const first = page.getByTestId('question-card').filter({ hasText: prompts[0]! });
      const second = page.getByTestId('question-card').filter({ hasText: prompts[1]! });
      await expect(first).toHaveAttribute('data-sync', 'ready');
      await first.getByRole('textbox', { name: '其他回答' }).fill(freeText);
      await first.getByRole('button', { name: '提交', exact: true }).click();
      await expect.poll(() => ctx.store.interactions.get(session.id, 'answer', (events().find(event => event.kind === 'question')!.data as EventData['question']).questionId)?.state).toBe('collected');
      assert.equal(events().filter(event => event.kind === 'question' && (event.data as EventData['question']).status === 'answered').length, 0);
      await page.reload(); await expect(first).toHaveAttribute('data-sync', 'ready');
      assert.ok(through() !== undefined, 'Missing actual WebSocket replay boundary');
      await second.getByRole(agent === 'codex' ? 'radio' : 'checkbox', { name: /^Alpha/ }).check();
      if (agent !== 'codex') await second.getByRole('checkbox', { name: /^Beta/ }).check();
      await second.getByRole('button', { name: '提交', exact: true }).click();
      await expect(first).toHaveAttribute('data-state', 'resolved', { timeout: 20_000 });
      await expect(second).toHaveAttribute('data-state', 'resolved');
      await expect.poll(() => events().filter(event => event.kind === 'turn.completed').length, { timeout: 20_000 }).toBe(1);
      assert.ok(events().some(event => event.kind === 'assistant.message' && (event.data as { text: string }).text === expectedText));
      const modelBodies = JSON.stringify(control.requests.map(request => request.body));
      assert.ok(modelBodies.includes(freeText), 'Original free text never reached the native model continuation');
      assert.ok(modelBodies.includes('Alpha'), 'Selected option never reached native continuation');
      if (agent !== 'codex') assert.ok(modelBodies.includes('Beta'), 'Second multi-select option lost');
      const nativeReplies = frames.filter(frame => frame.dir === 'out' && (agent !== 'codex' || frame.ch === 'rpc' && 'result' in (frame.frame as object)));
      if (agent === 'codex') {
        const replies = nativeReplies.map(frame => frame.frame as { result?: { answers?: unknown } }).filter(frame => frame.result?.answers !== undefined);
        assert.equal(replies.length, 1, 'Native question group must receive exactly one answer');
        assert.deepEqual(replies[0]!.result, { answers: { q0: { answers: [freeText] }, q1: { answers: ['Alpha'] } } });
        assert.equal((await (adapter as CodexAdapter).inputModes(session.id)).observedMode, 'plan');
      } else if (agent === 'claude-code') {
        const reply = nativeReplies.find(frame => frame.ch === 'canUseTool-result' && (frame.frame as { toolName?: string }).toolName === 'AskUserQuestion');
        assert.ok(reply);
        assert.deepEqual((reply.frame as { result: { updatedInput: { answers: unknown } } }).result.updatedInput.answers, { [prompts[0]!]: freeText, [prompts[1]!]: 'Alpha, Beta' });
      }
      result['nativeReplyFingerprint'] = createHash('sha256').update(JSON.stringify(nativeReplies)).digest('hex');
      result['nativeReplies'] = nativeReplies;
      const questionEventsBeforeReload = events().filter(event => event.kind === 'question');
      await page.reload(); await expect(first).toHaveAttribute('data-sync', 'ready');
      await expect(first).toHaveAttribute('data-state', 'resolved'); await expect(second).toHaveAttribute('data-state', 'resolved');
      assert.equal(await first.getByRole('button').count() + await second.getByRole('button').count(), 0);
      assert.deepEqual(events().filter(event => event.kind === 'question'), questionEventsBeforeReload);
      if (agent === 'codex') await expect(page.getByTestId('codex-input-mode')).toHaveValue('plan');
      result['outcome'] = 'two-native-questions-browser-answer-native-continue-and-reload';
    }
    const nativeUser = events().find(event => event.kind === 'user.message'); assert.ok(nativeUser);
    assert.equal((nativeUser.data as { text: string }).text, inputText);
    if (agent === 'codex') {
      const outgoing = frames.filter(frame => frame.dir === 'out' && frame.ch === 'rpc').map(frame => frame.frame as { method?: string; params?: Record<string, unknown> });
      assert.deepEqual(outgoing.find(frame => frame.method === 'initialize')?.params?.['capabilities'], { experimentalApi: true, requestAttestation: false });
      const turn = outgoing.find(frame => frame.method === 'turn/start')?.params;
      assert.ok(turn);
      assert.deepEqual(turn['input'], [{ type: 'text', text: inputText, text_elements: [] }]);
      assert.equal((turn['collaborationMode'] as { settings: { developer_instructions: unknown } }).settings.developer_instructions, null);
      result['nativeTurnStart'] = turn;
    }
    result['questions'] = events().filter(event => event.kind === 'question');
    result['terminal'] = events().findLast(event => event.kind === 'turn.completed');
    result['sourceSchemaFingerprint'] = ctx.store.nativeEvents.schemaHash;
    result['modelRequests'] = control.requests.length;
    result['passed'] = true;
  } catch (error) {
    result['error'] = error instanceof Error ? error.message : String(error);
    result['sessions'] = ctx.store.listSessions(true).map(session => ({ session, events: ctx.store.allEvents(session.id) }));
    result['frames'] = frames;
    result['modelBodies'] = control.requests.map(request => request.body);
    process.exitCode = 1;
  } finally {
    await browser?.close(); await ctx.close();
    if (adapter instanceof DshAdapter) await adapter.shutdown();
    await model.close(); await rm(isolated.dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    result['endedAt'] = new Date().toISOString(); (report['results'] as unknown[]).push(result);
    report['finalSourceFingerprint'] = sourceFingerprint();
    report['passed'] = (report['results'] as { passed: boolean }[]).length === selectedCases.length
      && (report['results'] as { passed: boolean }[]).every(result => result.passed) && report['finalSourceFingerprint'] === report['sourceFingerprint'];
    report['endedAt'] = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ case: name, passed: result['passed'], outcome: result['outcome'], error: result['error'], report: reportPath }) + '\n');
  }
}
