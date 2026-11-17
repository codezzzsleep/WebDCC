import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { AdapterEvent, EventData, TraceFrame } from '@webdcc/protocol';
import { isValidEventData } from '@webdcc/protocol';
import { ClaudeAdapter } from './adapter.js';
function frames(scenario: string): TraceFrame[] { return readFileSync(`fixtures/traces/claude-code/default/${scenario}/native.jsonl`, 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
it('real captured Write/Read/Bash blocks produce valid live and final file/tool items', () => {
  const counts = new Map<string, number>();
  for (const scenario of ['S01','S02','S03','S04','S05','S06','S07','S08','S09','S10','S11']) {
    const replay = ClaudeAdapter.replay();
    for (const frame of frames(scenario)) {
      const events = replay.feed(frame);
      for (const event of events) if (event.type === 'item.start' || event.type === 'item.complete') expect(isValidEventData(event.kind, event.data), `${scenario} frame ${frame.i} ${event.kind}`).toBe(true);
      const raw = frame.frame as { type?: string; message?: { content?: { type: string; name?: string; id?: string; input?: { file_path?: string; command?: string } }[] } };
      if (raw.type !== 'assistant' || !Array.isArray(raw.message?.content)) continue;
      const blocks = raw.message.content.filter(block => block.type === 'tool_use');
      const starts = events.filter((event): event is Extract<AdapterEvent, { type: 'item.start' }> => event.type === 'item.start');
      expect(starts).toHaveLength(blocks.length);
      for (const [index, block] of blocks.entries()) {
        const start = starts[index];
        expect(start?.native).toBe(frame.frame);
        if (block.name === 'Read') { expect(start?.kind).toBe('file.read'); expect(start?.data).toMatchObject({ path: block.input?.file_path }); }
        if (block.name === 'Write') { expect(start?.kind).toBe('file.change'); expect(start?.data).toMatchObject({ changes: [{ path: block.input?.file_path }] }); }
        if (block.name === 'Bash') { expect(start?.kind).toBe('command'); expect(start?.data).toMatchObject({ command: block.input?.command }); }
        counts.set(block.name ?? '', (counts.get(block.name ?? '') ?? 0) + 1);
      }
    }
  }
  expect(Object.fromEntries(counts)).toMatchObject({ Read: 6, Write: 5, Bash: 5, AskUserQuestion: 1 });
});
it('multiple questions wait for every answer and return native question-text keys', async () => {
  const replay = ClaudeAdapter.replay('s');
  const events = replay.feed({ i: 1, t: 0, dir: 'in', ch: 'canUseTool', frame: { toolName: 'AskUserQuestion', toolUseID: 'tool1', input: { questions: [{ question: '语言', options: [] }, { question: '版本', options: [] }] } } });
  expect(events.filter(event => event.type === 'item.complete' && event.kind === 'question')).toHaveLength(2);
  await replay.adapter.answer('s', 'tool1:0', { value: '中文' }); expect(replay.decisions).toHaveLength(0);
  await replay.adapter.answer('s', 'tool1:1', { value: '新版' });
  await new Promise(resolve => setImmediate(resolve));
  expect(replay.decisions).toEqual([{ behavior: 'allow', updatedInput: { questions: [{ question: '语言', options: [] }, { question: '版本', options: [] }], answers: { '语言': '中文', '版本': '新版' } } }]);
});

it('question completion waits for the matching native SDK tool result; rejected questions preserve their text and end after native confirmation', async () => {
  const replay = ClaudeAdapter.replay('s');
  const observed: AdapterEvent[] = [];
  replay.adapter.onEvent((_id, event) => { observed.push(event); });
  const ask = (id: string): void => { replay.feed({ i: 1, t: 0, dir: 'in', ch: 'canUseTool', frame: { toolName: 'AskUserQuestion', toolUseID: id, input: { questions: [{ question: '原始问题', options: [] }] } } }); };
  const toolResult = (id: string, isError = false): void => { replay.feed({ i: 2, t: 1, dir: 'in', ch: 'sdk', frame: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'native tool result' }] }, parent_tool_use_id: null } }); };
  const resolutions = (): AdapterEvent[] => observed.filter(event => event.type === 'item.complete' && event.kind === 'question' && (event.data as EventData['question']).status !== undefined);
  ask('accepted');
  expect(await replay.adapter.answer('s', 'accepted:0', { custom: '  原生正文  ' })).toMatchObject({ submitted: true, confirmed: false });
  await new Promise(resolve => setImmediate(resolve));
  expect(resolutions()).toHaveLength(0);
  toolResult('unrelated'); expect(resolutions()).toHaveLength(0);
  toolResult('accepted'); expect(resolutions()).toMatchObject([{ data: { questionId: 'accepted:0', prompt: '原始问题', status: 'answered', resolution: 'native-acknowledged' } }]);
  ask('cancelled'); await replay.adapter.cancelPending('s'); await new Promise(resolve => setImmediate(resolve));
  expect(resolutions()).toHaveLength(1);
  toolResult('cancelled', true);
  expect(resolutions()).toMatchObject([{}, { data: { questionId: 'cancelled:0', prompt: '原始问题', status: 'skipped', outcome: 'cancel', resolution: 'native-acknowledged' } }]);
  await expect(replay.adapter.answer('s', 'cancelled:0', { custom: 'stale' })).rejects.toMatchObject({ statusCode: 409 });
});
