import { expect, it } from 'vitest';
import { DiagnosticCapture, diagnosticSecretsFromHeaders, redactDiagnosticBytes, redactDiagnosticValue } from './redaction.js';

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
