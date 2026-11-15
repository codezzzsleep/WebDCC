import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import type { TraceFrame } from '../packages/protocol/src/trace.js';
import { runFixture } from './l1-replay.js';

const source = 'fixtures/traces/codex/default/S01';
type UserFrame = { method: string; params: { item: { type: string; id: string; clientId: string | null; content: unknown[] } } };
const user = (frame: TraceFrame): UserFrame | undefined => {
  const raw = frame.frame as UserFrame;
  return raw?.params?.item?.type === 'userMessage' ? raw : undefined;
};

async function fixture(mutate: (frames: TraceFrame[]) => TraceFrame[] = frames => frames) {
  const path = await mkdtemp(join(tmpdir(), 'wdcc-l1-input-'));
  const frames = (await readFile(join(source, 'native.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as TraceFrame);
  await writeFile(join(path, 'meta.json'), await readFile(join(source, 'meta.json')));
  await writeFile(join(path, 'native.jsonl'), mutate(frames).map(frame => JSON.stringify(frame)).join('\n') + '\n');
  return { path, close: () => rm(path, { recursive: true, force: true }) };
}

it('projects the actual legacy first input once without inventing a Web command identity', async () => {
  const ctx = await fixture();
  try {
    const result = await runFixture(ctx.path);
    expect(result.invariants.failures.filter(failure => failure.id === 'I3')).toEqual([]);
    expect(result.views?.[0]?.inputs).toBeUndefined();
    expect(result.views?.[0]?.user).toMatchObject({ text: '用一句话解释什么是幂等。不要使用任何工具。' });
    expect(result.views?.[0]?.user.commandId).toBeUndefined();
  } finally { await ctx.close(); }
});

it('preserves a real native client identity in the first input', async () => {
  const ctx = await fixture(frames => frames.map(frame => {
    const raw = user(frame);
    if (raw) raw.params.item.clientId = 'recorded-native-command';
    return frame;
  }));
  try {
    const result = await runFixture(ctx.path);
    expect(result.invariants.failures.filter(failure => failure.id === 'I3')).toEqual([]);
    expect(result.views?.[0]?.user.commandId).toBe('recorded-native-command');
    expect(result.views?.[0]?.inputs).toBeUndefined();
  } finally { await ctx.close(); }
});

it('still fails an extra unidentified input even when its text equals the first input', async () => {
  const ctx = await fixture(frames => frames.flatMap(frame => {
    const raw = user(frame);
    if (raw?.method !== 'item/completed') return [frame];
    const extra = structuredClone(frame);
    (extra.frame as UserFrame).params.item.id = 'additional-input-without-identity';
    return [frame, extra];
  }));
  try {
    const result = await runFixture(ctx.path);
    expect(result.invariants.failures.some(failure => failure.id === 'I3' && failure.message.includes('介入命令身份'))).toBe(true);
    expect(result.views?.[0]?.inputs).toHaveLength(2);
  } finally { await ctx.close(); }
});

it('fails when the trace never supplies a native input instead of fabricating one from meta', async () => {
  const ctx = await fixture(frames => frames.filter(frame => !user(frame)));
  try {
    const result = await runFixture(ctx.path);
    expect(result.invariants.failures.some(failure => failure.id === 'I3' && failure.message.includes('原生输入证据'))).toBe(true);
    expect(result.views?.[0]?.user.text).toBe('');
  } finally { await ctx.close(); }
});
