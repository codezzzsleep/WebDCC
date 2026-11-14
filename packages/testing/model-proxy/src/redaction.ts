/** Shared by diagnostic observers; native payloads never use these results. */
export const sensitiveDiagnosticField = /^(?:.*[_-])?(authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|secret|credentials|encrypted[_-]?content|signature)$/i;

function collect(value: unknown, candidates: Set<string>, sensitive = false): void {
  if (typeof value === 'string') {
    if (sensitive && value !== '') { candidates.add(value); candidates.add(JSON.stringify(value).slice(1, -1)); }
  } else if (Array.isArray(value)) for (const child of value) collect(child, candidates, sensitive);
  else if (value !== null && typeof value === 'object') for (const [key, child] of Object.entries(value)) collect(child, candidates, sensitive || sensitiveDiagnosticField.test(key));
}

/** Byte masks preserve lengths and recorded transport chunk boundaries. JSON
 * fields are inspected before masking, including escaped credential strings. */
export function redactDiagnosticBytes(bytes: Buffer, secrets: readonly string[] = []): Buffer {
  const result = Buffer.from(bytes);
  const text = bytes.toString('utf8');
  const candidates = new Set(secrets.filter(Boolean));
  for (const secret of secrets) if (secret !== '') candidates.add(JSON.stringify(secret).slice(1, -1));
  for (const pattern of [ /\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]+/g, /\bBearer\s+([^\s"']+)/gi, /[?&](?:token|api[_-]?key|key|secret|password|signature)=([^&\s"']+)/gi, /https?:\/\/[^\s/@"']+:([^\s/@"']+)@/gi ]) {
    for (const match of text.matchAll(pattern)) candidates.add(match[1] ?? match[0]);
  }
  for (const match of text.matchAll(/"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    try { if (sensitiveDiagnosticField.test(JSON.parse(`"${match[1]}"`) as string)) candidates.add(match[2]!); } catch { /* incomplete diagnostic JSON */ }
  }
  try { collect(JSON.parse(text), candidates); } catch {
    for (const line of text.split('\n')) if (line.startsWith('data:')) { try { collect(JSON.parse(line.slice(5).trim()), candidates); } catch { /* non-JSON SSE event */ } }
  }
  // Longest first, and search the untouched bytes so overlapping credentials
  // cannot expose the suffix of a longer value after an earlier replacement.
  for (const secret of [...candidates].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const needle = Buffer.from(secret);
    for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + 1)) result.fill(42, at, at + needle.length);
  }
  return result;
}

export function redactDiagnosticValue(value: unknown, secrets: readonly string[] = [], field = '', ancestors = new Set<object>()): unknown {
  if (sensitiveDiagnosticField.test(field)) return '<redacted>';
  if (typeof value === 'string') return redactDiagnosticBytes(Buffer.from(value), secrets).toString('utf8');
  if (value !== null && typeof value === 'object') {
    if (ancestors.has(value) || ancestors.size >= 64) return '<unserializable>';
    ancestors.add(value);
    const result = Array.isArray(value) ? value.map(child => redactDiagnosticValue(child, secrets, field, ancestors))
      : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactDiagnosticValue(child, secrets, key, ancestors)]));
    ancestors.delete(value);
    return result;
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') return '<unserializable>';
  return value;
}

export function diagnosticSecretsFromHeaders(headers: Record<string, string | string[] | undefined>): string[] {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(headers)) if (sensitiveDiagnosticField.test(key)) {
    for (const text of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      secrets.push(text, text.replace(/^Bearer\s+/i, ''));
      if (/cookie/i.test(key)) for (const part of text.split(';')) { const at = part.indexOf('='); if (at >= 0) secrets.push(part.slice(at + 1).trim()); }
    }
  }
  return secrets.filter(Boolean);
}

export interface CapturedChunk { t: number; bytes: Buffer }
/** Drop the entire payload on overflow so a cut credential prefix is never
 * persisted as apparently complete evidence. Transport still forwards bytes. */
export class DiagnosticCapture {
  readonly chunks: CapturedChunk[] = [];
  bytes = 0;
  count = 0;
  truncated = false;
  constructor(readonly maxBytes = 8 * 1024 * 1024, readonly maxChunks = 4096) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxChunks) || maxChunks < 1) throw new Error('Invalid diagnostic capture limits');
  }
  push(bytes: Buffer, t: number): void {
    this.bytes += bytes.length; this.count++;
    if (this.bytes > this.maxBytes || this.count > this.maxChunks) { this.truncated = true; this.chunks.length = 0; }
    if (!this.truncated) this.chunks.push({ t, bytes: Buffer.from(bytes) });
  }
  buffer(): Buffer { return Buffer.concat(this.chunks.map(chunk => chunk.bytes)); }
}
