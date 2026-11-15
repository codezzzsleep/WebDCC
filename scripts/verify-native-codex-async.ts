/** Default async questions: actual Codex, file SQLite, REST/WS and Chromium.
 * The loopback Responses fixture schedules tools, never adapter/native events. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import type { EventData, StoredEvent, TraceFrame } from '../packages/protocol/src/index.js';
import { codexAsyncQuestionId, formatCodexAsyncReply, parseCodexAsyncReplies } from '../packages/protocol/src/codex-questions.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { createSourceTestApp, observeSessionSnapshots } from '../browser-tests/helpers.js';
import { isolatedEnv } from '../packages/server/src/test-isolation.js';
import { openDb } from '../packages/server/src/db.js';
import { startResponsesMock } from '../packages/testing/mock-models/src/responses-server.js';
import { MockControl } from '../packages/testing/mock-models/src/mock-control.js';
import type { Plan } from '../packages/testing/mock-models/src/plan.js';
import { sourceFingerprint } from './lib/gate-report.js';

export const asyncQuestionCases = ['codex-default-async-idle', 'codex-default-async-finish-window', 'codex-default-async-steer', 'codex-default-async-queue', 'codex-default-async-external-queue', 'codex-default-async-restore', 'codex-default-async-stop'] as const;
export type AsyncQuestionCase = typeof asyncQuestionCases[number];
type Rpc = { method?: string; params?: Record<string, unknown>; result?: unknown; id?: unknown };
const rpcFrames = (frames: TraceFrame[], direction: 'in' | 'out'): Rpc[] => frames.filter(frame => frame.dir === direction && frame.ch === 'rpc').map(frame => frame.frame as Rpc);
const userText = (item: Record<string, unknown>): string => Array.isArray(item['content']) ? item['content'].flatMap(part => part?.type === 'text' ? [String(part.text ?? '')] : []).join('\n') : '';
const modelInput = (body: unknown): Record<string, unknown>[] => body !== null && typeof body === 'object' && 'input' in body && Array.isArray(body.input) ? body.input : [];
const modelReplies = (body: unknown) => modelInput(body).filter(item => item['type'] === 'message' && item['role'] === 'user').flatMap(item => {
  const content = item['content'];
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.flatMap(part => part?.type === 'input_text' ? [String(part.text ?? '')] : []).join('\n') : '';
  return parseCodexAsyncReplies(text);
});
const nativeAccepted = (body: unknown, callId: string): boolean => modelInput(body).some(item => {
  if (item['type'] !== 'function_call_output' || item['call_id'] !== callId || typeof item['output'] !== 'string') return false;
  try { return (JSON.parse(item['output']) as { accepted?: boolean }).accepted === true; } catch { return false; }
});

export async function verifyCodexAsyncQuestionCase(binary: string, name: AsyncQuestionCase, reportPath: string): Promise<Record<string, unknown>> {
  const isolated = isolatedEnv({ PATH: process.env['PATH'] }, 'wdcc-native-async-question');
  const workspacePath = join(isolated.dirs.root, 'workspace'); await mkdir(workspacePath);
  const dbPath = join(isolated.dirs.data, 'webdcc.sqlite');
  const prompts = ['Which environment should I use?', 'What deadline should I use?'];
  const questions = [{ title: prompts[0]!, options: ['Staging', 'Production'] }, { title: prompts[1]! }];
  const freeText = '  原生自由答案 中文\n保留换行  ';
  const callId = name + '-questions';
  const initialInput = '  Ask the configured questions and keep working. 中文  ';
  const external = name.endsWith('-external-queue');
  const running = name.endsWith('-steer') || name.endsWith('-queue') || name.endsWith('-stop');
  const expectedText = name + ': native continued execution';
  // Hold the actual continuation model response while Chromium operates.
  // This is controlled model latency, with no injected native event/status.
  let releaseContinuation: () => void = () => undefined;
  const continuation = new Promise<void>(resolve => { releaseContinuation = resolve; });
  const plan: Plan = [{ tool: { kind: 'ask', name: 'request_user_input_async', namespace: 'functions', callId, input: { questions } } }, { text: expectedText }];
  const control = new MockControl(plan, '');
  const model = await startResponsesMock({ plan, control, modelId: 'gpt-6.1-sol', chunkSize: 12, log: () => undefined,
    ...(running ? { beforeReply: async (body: Record<string, unknown>) => { if (nativeAccepted(body, callId)) await continuation; } } : {}) });
  const frames: TraceFrame[] = [];
  const webSocketFrames: { direction: 'in' | 'out'; frame: unknown }[] = [];
  const commands: Record<string, unknown>[] = [];
  const actions: string[] = [];
  const env = { ...isolated.env, WDCC_MOCK_KEY: 'fixture-only' };
  const overrides = ['model_provider=wdcc_mock', 'model="gpt-6.1-sol"', 'model_providers.wdcc_mock.name="WDCC isolated async fixture"',
    `model_providers.wdcc_mock.base_url="${model.url}/v1"`, 'model_providers.wdcc_mock.wire_api="responses"', 'model_providers.wdcc_mock.env_key="WDCC_MOCK_KEY"',
    'model_providers.wdcc_mock.request_max_retries=0', 'model_providers.wdcc_mock.stream_max_retries=0'];
  const adapterOptions = { command: binary, configOverrides: overrides, env, traceSink: { record: (frame: TraceFrame): void => { frames.push(structuredClone(frame)); } } };
  let ctx = await createSourceTestApp({ dbPath });
  let browser: Browser | undefined;
  let page: Page | undefined;
  let through: (() => number | undefined) | undefined;
  let adapter = new CodexAdapter(adapterOptions);
  const result: Record<string, unknown> = { case: name, agent: 'codex', passed: false, startedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint: sourceFingerprint(),
    model: 'gpt-6.1-sol', catalog: 'binary-native-catalog-without-overrides', collaborationModeOverride: null,
    paidModel: false, storage: 'isolated-file-sqlite', uiActions: actions, expectedPredicates: ['native-default-mode', 'native-async-item', 'two-web-questions', 'native-accepted-and-continued', 'native-answer-identities', 'model-received-original-answers', 'refresh-keeps-resolved',
      ...(external ? ['direct-native-input-bypasses-web-command', 'external-answer-cancels-old-web-queue', 'cancelled-web-answer-never-native-sent']
        : name.endsWith('-steer') ? ['native-steer-received'] : name.endsWith('-queue') ? ['real-queued-browser-answers', 'refresh-does-not-resend-queue']
        : name.endsWith('-finish-window') ? ['second-answer-in-real-finish-window'] : name.endsWith('-restore') ? ['file-sqlite-and-native-reopened'] : name.endsWith('-stop') ? ['native-stop-before-later-answer'] : [])] };
  result['configurationFingerprint'] = createHash('sha256').update(JSON.stringify({ overrides, questions, plan, envKeys: Object.keys(env).sort() })).digest('hex');
  const evidencePath = reportPath + '.' + name + '.trace.json';
  try {
    const nativeVersion = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim().replace(/^codex-cli\s+/, '');
    assert.equal(nativeVersion, '0.169.0', 'Async catalog acceptance currently audited against native 0.169.0; use the reviewed binary');
    result['nativeVersion'] = nativeVersion;
    result['binarySha256'] = createHash('sha256').update(await readFile(binary)).digest('hex');
    result['schemaFingerprint'] = ctx.store.nativeEvents.schemaHash;
    ctx.manager.registerAdapter(adapter);
    const workspace = ctx.store.createWorkspace('Native Default async ' + name, workspacePath);
    const session = await ctx.manager.createSession({ workspaceId: workspace.id, agent: 'codex' });
    const events = (): StoredEvent[] => ctx.store.allEvents(session.id);
    const latestQuestions = (): Map<string, EventData['question']> => new Map(events().filter(event => event.kind === 'question').map(event => [(event.data as EventData['question']).questionId, event.data as EventData['question']]));
    const openPage = async (): Promise<Page> => {
      await ctx.app.listen({ host: '127.0.0.1', port: 0 });
      const address = ctx.app.server.address(); assert.ok(address && typeof address !== 'string');
      const base = 'http://127.0.0.1:' + address.port;
      const current = await browser!.newPage(); through = observeSessionSnapshots(current, session.id);
      current.on('websocket', socket => {
        socket.on('framesent', payload => {
          const frame = JSON.parse(String(payload.payload)) as { op?: string; command?: Record<string, unknown> };
          webSocketFrames.push({ direction: 'out', frame });
          if (frame.op === 'command' && frame.command !== undefined) commands.push(structuredClone(frame.command));
        });
        socket.on('framereceived', payload => { webSocketFrames.push({ direction: 'in', frame: JSON.parse(String(payload.payload)) }); });
      });
      current.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/commands') {
          const body = request.postDataJSON() as Record<string, unknown>;
          commands.push(structuredClone(body));
        }
      });
      await current.context().addCookies([{ name: 'wdcc-auth', value: ctx.cookie.slice('wdcc-auth='.length), url: base }]);
      await current.goto(base + '/s/' + session.id);
      await expect(current.getByTestId('composer-input')).toBeVisible();
      return current;
    };
    browser = await chromium.launch({ headless: true }); page = await openPage();
    await page.getByTestId('composer-input').fill(initialInput); await page.getByTestId('send-button').click();
    actions.push('Chromium sends normal input with inherited native mode; no Plan selection');
    await expect.poll(() => latestQuestions().size, { timeout: 25_000, message: 'NOT_TRIGGERED: native Default async must emit two real question cards' }).toBe(2);
    assert.ok(control.requests.every(request => request.failed !== true), 'Model fixture failed to match the actually declared native tools');
    const nativeAsync = rpcFrames(frames, 'in').find(frame => frame.method === 'item/completed' && (frame.params?.['item'] as { delivery?: string })?.delivery === 'async');
    assert.ok(nativeAsync, 'NOT_TRIGGERED: missing actual native async item');
    const nativeItem = nativeAsync.params!['item'] as Record<string, unknown>;
    assert.equal(nativeItem['id'], callId); assert.deepEqual(nativeItem['questions'], questions.map(question => ({ ...question, options: question.options ?? null })));
    for (const [index, question] of [...latestQuestions().values()].entries()) {
      assert.equal(question.questionId, codexAsyncQuestionId(callId, index));
      assert.equal(question.isBlocking, false); assert.equal(question.allowsFreeText, true);
      assert.equal(question.multiSelect, false); assert.equal(question.prompt, prompts[index]);
    }
    // Inherited mode can remain unreported by app-server. Prove the actual
    // native turn mode from its own rollout instead of inferring it from null.
    const nativeThreadReply = rpcFrames(frames, 'in').find(frame => (frame.result as { thread?: { id?: string } } | undefined)?.thread?.id === nativeAsync.params!['threadId']);
    const nativePath = (nativeThreadReply?.result as { thread?: { path?: string } } | undefined)?.thread?.path;
    assert.ok(nativePath, 'NOT_TRIGGERED: native thread did not supply its rollout path');
    type ModeContext = { type?: string; payload?: { turn_id?: string; model?: string; collaboration_mode?: { mode?: string } } };
    let modeContexts: ModeContext['payload'][] = [];
    await expect.poll(async () => {
      const rollout = await readFile(nativePath, 'utf8');
      modeContexts = rollout.split('\n').filter(Boolean).flatMap(line => {
        // The native writer may still be appending its final JSONL record.
        let row: ModeContext;
        try { row = JSON.parse(line) as ModeContext; } catch { return []; }
        if (row.type !== 'turn_context' || row.payload === undefined || row.payload.turn_id !== nativeAsync.params!['turnId']) return [];
        return [{ turn_id: row.payload.turn_id, model: row.payload.model, collaboration_mode: row.payload.collaboration_mode }];
      });
      return modeContexts.length > 0 && modeContexts.every(context => context?.collaboration_mode?.mode === 'default');
    }, { timeout: 10_000, message: 'NOT_TRIGGERED: native rollout must confirm Default for the actual async question turn' }).toBe(true);
    result['nativeModeEvidence'] = { nativeThreadId: nativeAsync.params!['threadId'], nativeTurnId: nativeAsync.params!['turnId'],
      nativeRolloutPath: nativePath, contexts: modeContexts, appServerObservedMode: (await adapter.inputModes(session.id)).observedMode };
    assert.notEqual(ctx.manager.getRuntime(session.id)?.status, 'waiting', 'Async arrival cannot force the native thread to wait');
    const initialTurn = rpcFrames(frames, 'out').find(frame => frame.method === 'turn/start')?.params;
    assert.ok(initialTurn); assert.equal(initialTurn['collaborationMode'], undefined);
    assert.deepEqual(initialTurn['input'], [{ type: 'text', text: initialInput, text_elements: [] }]);
    // The native model receives accepted=true immediately, before any answer.
    await expect.poll(() => control.requests.some(request => nativeAccepted(request.body, callId)), { timeout: 10_000 }).toBe(true);
    assert.ok(!control.requests.some(request => JSON.stringify(request.body).includes('<send_user_message_question_reply>')));
    assert.equal(rpcFrames(frames, 'in').filter(frame => frame.method === 'item/tool/requestUserInput').length, 0, 'Async is not a synchronous reverse RPC');
    if (!running) await expect.poll(() => events().filter(event => event.kind === 'turn.completed').length, { timeout: 15_000 }).toBe(1);
    if (name.endsWith('-stop')) {
      await page.getByTestId('stop-button').click(); actions.push('Chromium stops the original native turn before answering');
      await expect.poll(() => events().filter(event => event.kind === 'turn.completed').length, { timeout: 15_000 }).toBe(1);
      assert.equal((events().findLast(event => event.kind === 'turn.completed')!.data as EventData['turn.completed']).status, 'interrupted');
      assert.ok([...latestQuestions().values()].every(question => question.status !== 'answered'), 'Stopping async work must not manufacture a received answer');
      releaseContinuation();
    }
    let first = page.getByTestId('question-card').filter({ hasText: prompts[0]! });
    let second = page.getByTestId('question-card').filter({ hasText: prompts[1]! });
    await expect(first).toHaveAttribute('data-sync', 'ready'); await expect(first).toHaveAttribute('data-state', 'pending');
    await expect(first.getByRole('radio', { name: 'Staging', exact: true })).not.toBeChecked();
    await first.getByRole('radio', { name: 'Production', exact: true }).check();
    const queue = name.endsWith('-queue') && !external;
    const submit = async (card: typeof first, forceQueue = false): Promise<void> => {
      if (queue || forceQueue) await card.getByTestId('question-queue-answer').click();
      else await card.getByRole('button', { name: '提交', exact: true }).click();
    };
    await submit(first, external); actions.push(queue || external ? 'Chromium clicks queue-answer for first option question (Production)' : 'Chromium submits first option question');
    if (external) {
      await expect.poll(() => commands.filter(command => command['op'] === 'answer').length, { timeout: 10_000 }).toBe(1);
      const queuedCommand = commands.find(command => command['op'] === 'answer')!;
      assert.equal(queuedCommand['intent'], 'queue');
      const queuedId = queuedCommand['clientCommandId'] as string;
      await expect.poll(() => ctx.store.journal.get(queuedId)?.state, { timeout: 10_000 }).toBe('queued');
      assert.equal(events().filter(event => event.kind === 'turn.completed').length, 0, 'The old Web answer must really be queued behind a running native turn');
      const firstQuestion = latestQuestions().get(codexAsyncQuestionId(callId, 0))!;
      assert.equal(firstQuestion.status, undefined);
      const directText = formatCodexAsyncReply(firstQuestion, { selected: ['Staging'] });
      // Use the real adapter RPC, bypassing the Web command/journal entirely.
      // This tests direct native input, not a second OS process or CLI.
      await adapter.steer(session.id, { text: directText, expectedTurnId: nativeAsync.params!['turnId'] as string });
      const directRpc = rpcFrames(frames, 'out').find(frame => frame.method === 'turn/steer' && JSON.stringify(frame.params?.['input']).includes('Staging'));
      assert.ok(directRpc); assert.equal(directRpc.params?.['clientUserMessageId'], undefined);
      actions.push('Direct native adapter.steer submits Staging with no Web command and no nativeRequestId, while old Web Production remains queued');
      releaseContinuation();
      await expect(first).toHaveAttribute('data-state', 'resolved', { timeout: 25_000 });
      assert.equal(latestQuestions().get(firstQuestion.questionId)?.resolution, 'external');
      assert.equal(ctx.store.journal.get(queuedId)?.state, 'cancelled');
      assert.ok(!ctx.store.journal.queue(session.id).some(input => input.commandId === queuedId));
      const inspection = openDb(dbPath);
      try {
        const persisted = inspection.prepare('SELECT state, input FROM input_queue WHERE command_id = ?').get(queuedId) as { state: string; input: string } | undefined;
        assert.equal(persisted?.state, 'cancelled', 'An independent SQLite reader must see the actual queued input cancelled');
        result['cancelledWebInput'] = persisted; result['cancelledWebCommand'] = ctx.store.journal.get(queuedId);
      } finally { inspection.close(); }
      result['directNativeInput'] = directRpc;
      actions.push('Actual native userMessage echo marks external answer and cancels both persisted Web command and input_queue row before old answer can drain');
      const cancelledReplay = await page.request.post(new URL('/api/commands', page.url()).href, { data: queuedCommand });
      assert.equal(cancelledReplay.status(), 200); assert.equal(ctx.store.journal.get(queuedId)?.state, 'cancelled');
      actions.push('Replay the cancelled original Web command; it remains cancelled and cannot overwrite the native answer');
    }
    if (name.endsWith('-finish-window')) {
      await expect.poll(() => rpcFrames(frames, 'in').filter(frame => frame.method === 'turn/completed').length, { timeout: 15_000 }).toBe(2);
      assert.notEqual(ctx.manager.getRuntime(session.id)?.turnId, null, 'NOT_TRIGGERED: second answer must arrive during the actual manager finish-convergence window');
      actions.push('Wait for actual native turn/completed, then answer second question before WebDCC final-turn convergence; automatic delivery must safely queue');
    } else if (!running || name.endsWith('-stop')) {
      await expect(first).toHaveAttribute('data-state', 'resolved', { timeout: 15_000 });
      await expect.poll(() => events().filter(event => event.kind === 'turn.completed').length, { timeout: 15_000 }).toBe(2);
    }
    if (name.endsWith('-restore')) {
      await expect(first).toHaveAttribute('data-state', 'resolved', { timeout: 15_000 });
      await page.close(); await ctx.close();
      ctx = await createSourceTestApp({ dbPath }); adapter = new CodexAdapter(adapterOptions); ctx.manager.registerAdapter(adapter);
      page = await openPage();
      first = page.getByTestId('question-card').filter({ hasText: prompts[0]! });
      second = page.getByTestId('question-card').filter({ hasText: prompts[1]! });
      await expect(first).toHaveAttribute('data-state', 'resolved'); await expect(second).toHaveAttribute('data-sync', 'ready');
      await expect(second).toHaveAttribute('data-state', 'pending');
      actions.push('Close actual WebDCC/native connection; reopen the same file SQLite and native home with a new production adapter; keep one answered and one pending');
    }
    await expect(second).toHaveAttribute('data-sync', 'ready');
    await second.getByRole('textbox', { name: '其他回答' }).fill(freeText);
    await submit(second); actions.push(queue ? 'Chromium clicks queue-answer for free-text question' : 'Chromium submits original multiline free-text answer');
    await expect.poll(() => commands.filter(command => command['op'] === 'answer').length, { timeout: 10_000 }).toBe(2);
    if (queue) {
      await expect.poll(() => [...latestQuestions().values()].filter(question => question.submission === 'queued').length, { timeout: 10_000 }).toBe(2);
      assert.ok([...latestQuestions().values()].every(question => question.status !== 'answered'), 'Queueing alone must not show answered');
      assert.equal(events().filter(event => event.kind === 'turn.completed').length, 0, 'Queue scenario must actually submit during the running native turn');
      assert.ok(commands.filter(command => command['op'] === 'answer').every(command => command['intent'] === 'queue'));
      await page.reload(); actions.push('Refresh while both native answers are queued');
      await expect(first).toHaveAttribute('data-sync', 'ready');
      assert.equal(await first.getByRole('button', { name: '提交', exact: true }).isDisabled(), true, 'Pending queued answer cannot be sent twice after refresh');
    }
    releaseContinuation();
    await expect(first).toHaveAttribute('data-state', 'resolved', { timeout: 45_000 });
    await expect(second).toHaveAttribute('data-state', 'resolved', { timeout: 45_000 });
    const incoming = rpcFrames(frames, 'in');
    const nativeReplies = incoming.filter(frame => frame.method === 'item/completed' && (frame.params?.['item'] as { type?: string })?.type === 'userMessage')
      .flatMap(frame => parseCodexAsyncReplies(userText(frame.params!['item'] as Record<string, unknown>)));
    assert.deepEqual(nativeReplies, [
      { questionItemId: codexAsyncQuestionId(callId, 0), question: prompts[0], answer: external ? 'Staging' : 'Production' },
      { questionItemId: codexAsyncQuestionId(callId, 1), question: prompts[1], answer: freeText },
    ], 'Each original answer must be echoed by actual native input exactly once under its stable question identity');
    await expect.poll(() => control.requests.flatMap(request => modelReplies(request.body)).some(reply => reply.answer === freeText), { timeout: 25_000 }).toBe(true);
    const receivedByModel = control.requests.flatMap(request => modelReplies(request.body));
    for (const reply of nativeReplies) assert.ok(receivedByModel.some(received => received.answer === reply.answer && received.question === reply.question && received.questionItemId === reply.questionItemId), 'Native model request lost exact question identity or original answer bytes');
    const outgoing = rpcFrames(frames, 'out');
    const answerInputs = outgoing.filter(frame => ['turn/start', 'turn/steer'].includes(frame.method ?? '') && JSON.stringify(frame.params?.['input']).includes('<send_user_message_question_reply>'));
    assert.equal(answerInputs.length, 2, 'Answer group does not aggregate async identities or send duplicate ordinary input');
    if (name.endsWith('-steer')) assert.ok(answerInputs.some(frame => frame.method === 'turn/steer'), 'NOT_TRIGGERED: running scenario must exercise actual native steer');
    if (queue || !running || name.endsWith('-stop')) assert.ok(answerInputs.every(frame => frame.method === 'turn/start'), 'Queued/idle answers must use native ordinary-input starts');
    if (external) {
      assert.ok(answerInputs.some(frame => frame.method === 'turn/steer' && frame.params?.['clientUserMessageId'] === undefined));
      assert.ok(!answerInputs.some(frame => JSON.stringify(frame.params?.['input']).includes('Production')), 'The cancelled old Web answer must never be sent to native');
      assert.equal(latestQuestions().get(codexAsyncQuestionId(callId, 0))?.resolution, 'external');
    }
    assert.equal(outgoing.filter(frame => 'result' in frame && (frame.result as { answers?: unknown })?.answers !== undefined).length, 0);
    const answerCommand = commands.findLast(command => command['op'] === 'answer'); assert.ok(answerCommand);
    const answersBeforeDuplicate = answerInputs.length;
    const duplicate = await page.request.post(new URL('/api/commands', page.url()).href, { data: answerCommand });
    assert.equal(duplicate.status(), 200); assert.equal((await duplicate.json() as { ok?: boolean }).ok, true);
    const repeated = await page.request.post(new URL('/api/commands', page.url()).href, { data: { ...answerCommand, clientCommandId: name + '-duplicate-question' } });
    assert.equal((await repeated.json() as { ok?: boolean }).ok, false, 'A new command cannot answer an already-received question again');
    assert.equal(rpcFrames(frames, 'out').filter(frame => ['turn/start', 'turn/steer'].includes(frame.method ?? '') && JSON.stringify(frame.params?.['input']).includes('<send_user_message_question_reply>')).length, answersBeforeDuplicate);
    actions.push('Replay original persisted command and attempt a new duplicate answer; native answer count stays two');
    await page.reload(); await expect(first).toHaveAttribute('data-state', 'resolved'); await expect(second).toHaveAttribute('data-state', 'resolved');
    await expect(first).toHaveAttribute('data-sync', 'ready');
    assert.ok(through?.() !== undefined, 'Missing actual WebSocket replay boundary after refresh');
    assert.equal(await first.getByRole('button').count() + await second.getByRole('button').count(), 0);
    actions.push('Refresh and verify actual WS snapshot plus both ended cards without submit buttons');
    await page.screenshot({ path: reportPath + '.' + name + '.png', fullPage: true });
    result['nativePredicates'] = Object.fromEntries((result['expectedPredicates'] as string[]).map(key => [key, true]));
    result['nativeAnswerFingerprint'] = createHash('sha256').update(JSON.stringify(nativeReplies)).digest('hex');
    result['nativeAnswerInputs'] = answerInputs; result['nativeReplies'] = nativeReplies;
    result['questions'] = [...latestQuestions().values()]; result['modelRequests'] = control.requests.length;
    result['outcome'] = external ? 'direct-native-input-bypasses-web-command-cancels-old-web-queue-and-refreshes'
      : 'native-default-async-' + name.split('-').at(-1) + '-two-answers-received-and-refreshed';
    result['passed'] = true;
  } catch (error) {
    result['error'] = error instanceof Error ? error.message : String(error);
  } finally {
    releaseContinuation();
    const lastEvents = ctx.store.listSessions(true).flatMap(session => ctx.store.allEvents(session.id));
    await mkdir(resolve(reportPath, '..'), { recursive: true });
    await writeFile(evidencePath, JSON.stringify({ frames, webSocketFrames, commands, commandRecords: [...new Set(commands.map(command => command['clientCommandId']))].map(id => typeof id === 'string' ? ctx.store.journal.get(id) : undefined), events: lastEvents, modelRequests: control.requests, nativeModeEvidence: result['nativeModeEvidence'], nativeRecords: ctx.store.nativeEvents.list(undefined, 0, 200).map(record => ctx.store.nativeEvents.get(record.id)) }, null, 2) + '\n');
    result['evidence'] = [evidencePath]; result['endedAt'] = new Date().toISOString(); result['finalSourceFingerprint'] = sourceFingerprint();
    await browser?.close(); await ctx.close(); await model.close();
    await rm(isolated.dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  return result;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const option = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const binary = resolve(option('--binary') ?? '/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex');
  const reportPath = resolve(option('--report') ?? 'web_review/evidence/native-codex-async.json');
  const requested = option('--case');
  if (requested !== undefined && !asyncQuestionCases.includes(requested as AsyncQuestionCase)) throw new Error('Unknown --case');
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  const selected = asyncQuestionCases.filter(name => requested === undefined || name === requested);
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), sourceFingerprint: sourceFingerprint(), expectedCases: selected, kind: 'actual-native-default-async-file-sqlite-rest-ws-chromium', paidModel: false, results: [], passed: false };
  for (const name of selected) {
    const result = await verifyCodexAsyncQuestionCase(binary, name, reportPath); (report['results'] as unknown[]).push(result);
    report['passed'] = (report['results'] as { passed: boolean }[]).length === selected.length && (report['results'] as { passed: boolean }[]).every(result => result.passed) && sourceFingerprint() === report['sourceFingerprint'];
    report['endedAt'] = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ case: name, passed: result['passed'], outcome: result['outcome'], error: result['error'], report: reportPath }) + '\n');
  }
  if (report['passed'] !== true) process.exitCode = 1;
}
