import { expect, it } from 'vitest';
import { DiagnosticCapture, DiagnosticCaptureBudget, diagnosticSecretsFromHeaders, redactDiagnosticBytes, redactDiagnosticValue } from './redaction.js';

it('NP-14 masks nested and escaped credential fields without redacting token usage metadata or changing native objects', () => {
  const raw = { nested: { 'x-api-key': ['first key', 'second key'], credentials: { value: 'nested-value' }, encrypted_content: 'opaque-cipher' }, input_tokens: 123, text: 'keep me' };
  const before = structuredClone(raw);
  const masked = redactDiagnosticValue(raw);
  expect(masked).toEqual({ nested: { 'x-api-key': '<redacted>', credentials: '<redacted>', encrypted_content: '<redacted>' }, input_tokens: 123, text: 'keep me' });
  expect(raw).toEqual(before);
  const bytes = Buffer.from(JSON.stringify({ password: 'line\nwith "quotes"', nested: { api_key: 'key-value' }, text: 'keep me' }));
  const safe = redactDiagnosticBytes(bytes);
  expect(safe.length).toBe(bytes.length);
  expect(JSON.parse(safe.toString())).toMatchObject({ text: 'keep me' });
  expect(safe.toString()).not.toContain('key-value');
  expect(safe.toString()).not.toContain('quotes');
});

it('NP-14 competing captures share retained bytes and recover reservations on overflow, discard and repeated release', () => {
  const budget = new DiagnosticCaptureBudget(10);
  const first = new DiagnosticCapture(100, 10, budget);
  const second = new DiagnosticCapture(100, 10, budget);
  const native = Buffer.from('secret');
  first.push(native, 0); native.fill(0);
  expect(first.buffer().toString()).toBe('secret');
  second.push(Buffer.from('four'), 0);
  expect(budget.retainedBytes).toBe(10);
  expect(() => budget.configure(9)).toThrow('exceed');
  second.push(Buffer.from('x'), 1);
  expect(second).toMatchObject({ bytes: 5, count: 2, truncated: true, limitReason: 'active-buffer-budget', chunks: [] });
  expect(budget.retainedBytes).toBe(6);
  second.push(Buffer.alloc(100), 2);
  expect(second.bytes).toBe(105); expect(budget.retainedBytes).toBe(6);
  first.discard('capture-failed'); first.release(); first.release();
  expect(budget.retainedBytes).toBe(0);
  first.push(Buffer.from('late'), 3); expect(budget.retainedBytes).toBe(0);
  const next = new DiagnosticCapture(100, 10, budget);
  next.push(Buffer.alloc(10), 0); expect(budget.retainedBytes).toBe(10);
  next.release(); budget.configure(0);
  const zero = new DiagnosticCapture(100, 10, budget); zero.push(Buffer.from('x'), 0);
  expect(zero.limitReason).toBe('active-buffer-budget'); expect(budget.retainedBytes).toBe(0);
  for (const value of [-1, NaN, Infinity, 1.5]) {
    expect(() => budget.configure(value)).toThrow(); expect(() => budget.reserve(value)).toThrow(); expect(() => budget.release(value)).toThrow();
  }
  expect(() => budget.release(1)).toThrow();
});

it('NP-14 body and chunk overflows release their existing reservations', () => {
  const budget = new DiagnosticCaptureBudget(100);
  for (const capture of [new DiagnosticCapture(3, 10, budget), new DiagnosticCapture(100, 1, budget)]) {
    capture.push(Buffer.from('one'), 0); expect(budget.retainedBytes).toBe(3);
    capture.push(Buffer.from('two'), 1); expect(budget.retainedBytes).toBe(0);
    expect(capture.truncated).toBe(true);
  }
});

it('NP-14 overlapping credentials and cookie token fragments cannot reveal a longer credential suffix', () => {
  const secrets = diagnosticSecretsFromHeaders({ cookie: 'session=cookie-value; second=second-value', authorization: 'Bearer long-secret', 'x-api-key': ['first-secret', 'second-secret'] });
  const raw = Buffer.from('long-secret-and-more cookie-value second-value second-secret');
  expect(redactDiagnosticBytes(raw, [...secrets, 'long-secret-and-more']).toString()).toBe('******************** ************ ************ *************');
  expect(redactDiagnosticBytes(Buffer.from('https://operator:private-password@host.example?token=url-secret')).toString()).not.toContain('private-password');
});

it('NP-14 capture overflow drops the whole payload while keeping exact observation counts and bounded memory', () => {
  const capture = new DiagnosticCapture(8, 3);
  capture.push(Buffer.from('secret-'), 0);
  capture.push(Buffer.from('tail'), 1);
  expect(capture).toMatchObject({ bytes: 11, count: 2, truncated: true, chunks: [] });
  for (let i = 0; i < 100; i++) capture.push(Buffer.alloc(1024), i);
  expect(capture.chunks).toEqual([]);
  expect(capture.bytes).toBe(11 + 100 * 1024);
  const count = new DiagnosticCapture(100, 1);
  count.push(Buffer.from('one'), 0); count.push(Buffer.from('two'), 1);
  expect(count.truncated).toBe(true);
  expect(count.buffer().length).toBe(0);
});
