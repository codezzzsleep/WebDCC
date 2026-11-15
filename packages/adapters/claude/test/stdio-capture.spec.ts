import { once } from 'node:events';
import { expect, it } from 'vitest';
import type { TraceFrame } from '@webdcc/protocol';
import { managedClaudeProcess } from '../src/managed-process.js';
import { ClaudeStdioLines, type ClaudeStdioEnvelope } from '../src/stdio-capture.js';

it('preserves early stdout and every stdin byte across UTF8 fragments, CRLF and multiple native lines', async () => {
  const early = Buffer.from('{"type":"future","text":"汉🙂"}\r\n');
  const input = Buffer.concat([Buffer.from('{"type":"control_request","request_id":"exact-string-id","request":{"subtype":"initialize"}}\n{"type":"future-input","text":" 字\n"}\n'), Buffer.from([0xff, 0x0a])]);
  const captured: TraceFrame<ClaudeStdioEnvelope>[] = [];
  const child = managedClaudeProcess({ command: process.execPath, args: ['-e', `const initial=Buffer.from(process.env.WDCC_STDIO_EARLY,'base64');
let i=0;const write=()=>{if(i<initial.length){process.stdout.write(initial.subarray(i,i+1));i++;setImmediate(write)}};write();
const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>process.stdout.end(Buffer.concat(chunks)));`],
    env: { WDCC_STDIO_EARLY: early.toString('base64') }, signal: new AbortController().signal }, () => undefined, undefined,
    { record: frame => captured.push(frame) });
  const exited = once(child as unknown as NodeJS.EventEmitter, 'exit');
  try {
    // No SDK stdout listener yet: the tee must retain this early native frame.
    await expect.poll(() => captured.some(frame => frame.frame.frame['type'] === 'future')).toBe(true);
    const output: Buffer[] = [];
    const reading = (async () => { for await (const chunk of child.stdout) output.push(Buffer.from(chunk as Buffer)); })();
    for (let index = 0; index < input.length; index += 3) child.stdin.write(input.subarray(index, index + 3));
    child.stdin.end();
    await reading; await exited;
    expect(Buffer.concat(output)).toEqual(Buffer.concat([early, input]));
    const first = captured.find(frame => frame.frame.frame['type'] === 'future')!;
    expect(first.frame.frame).toEqual({ type: 'future', text: '汉🙂' });
    expect(first.frame.stdio).toMatchObject({ stream: 'stdout', line: 1, byteLength: early.length, coverage: 'complete', terminated: true });
    const request = captured.find(frame => frame.dir === 'out' && frame.frame.frame['type'] === 'control_request')!;
    expect(request.frame.frame['request_id']).toBe('exact-string-id');
    expect(captured.some(frame => frame.frame.stdio.coverage === 'invalid-utf8')).toBe(true);
    expect(captured.every(frame => !JSON.stringify(frame.frame.stdio).includes('sha256'))).toBe(true);
  } finally { child.kill('SIGKILL'); }
});

it('oversize, badJSON, bad UTF8, stderr and unterminated lines expose safe coverage without raw text or hashes', () => {
  const frames: ClaudeStdioEnvelope[] = [];
  const stdout = new ClaudeStdioLines('stdout', frame => frames.push(frame), 64);
  const secret = 'low-entropy-private-answer';
  const bytes = Buffer.concat([Buffer.from(JSON.stringify({ answer: secret.repeat(20) }) + '\n'), Buffer.from(secret + '\n'), Buffer.from([0xff, 0x0a]), Buffer.from('{"partial":')]);
  for (let offset = 0; offset < bytes.length; offset += 7) stdout.feed(bytes.subarray(offset, offset + 7));
  stdout.finish();
  const stderr = new ClaudeStdioLines('stderr', frame => frames.push(frame), 64);
  stderr.feed(Buffer.from(secret + '\n')); stderr.finish();
  const finished = frames.filter(frame => frame.stdio.terminated || frame.frame['omitted'] === 'unterminated-invalid-json');
  expect(finished.map(frame => frame.stdio.coverage)).toEqual(['oversize', 'invalid-json', 'invalid-utf8', 'incomplete', 'unstructured']);
  expect(JSON.stringify(frames)).not.toContain(secret);
  expect(JSON.stringify(frames)).not.toMatch(/sha256|digest|hash|base64/);
  expect(finished[0]?.stdio.byteLength).toBe(Buffer.byteLength(JSON.stringify({ answer: secret.repeat(20) }) + '\n'));
  expect(finished[3]?.stdio.terminated).toBe(false);
  expect(frames.some(frame => frame.stdio.coverage === 'oversize' && !frame.stdio.terminated)).toBe(true);
});

it('honors stream backpressure and sends exact bytes even when the raw observer throws', async () => {
  const input = Buffer.from('{"text":"汉🙂"}\n'.repeat(32000));
  const child = managedClaudeProcess({ command: process.execPath, args: ['-e', `const chunks=[];process.stdin.pause();setTimeout(()=>{process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>process.stdout.end(Buffer.concat(chunks)));process.stdin.resume()},50);`],
    env: {}, signal: new AbortController().signal }, () => undefined, undefined, { record: () => { throw new Error('observer unavailable'); }, maxLineBytes: 64 });
  try {
    const output: Buffer[] = [];
    const reading = (async () => { for await (const chunk of child.stdout) output.push(Buffer.from(chunk as Buffer)); })();
    expect(child.stdin.write(input)).toBe(false);
    await once(child.stdin, 'drain'); child.stdin.end();
    await reading;
    expect(Buffer.concat(output)).toEqual(input);
  } finally { child.kill('SIGKILL'); }
});
