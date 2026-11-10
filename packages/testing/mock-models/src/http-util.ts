import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface MockLogger {
  (line: string, extra?: unknown): void;
}

export const defaultLogger: MockLogger = (line, extra) => {
  const suffix = extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  process.stderr.write(`[mock] ${line}${suffix}\n`);
};

/** 读取并解析 JSON 请求体 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  return JSON.parse(raw);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

export function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** 把请求原样追加到 JSONL，用于录制 fixtures（脱敏在录制侧做） */
export class JsonlRecorder {
  private ready: Promise<unknown> | null = null;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  record(entry: unknown): void {
    this.ready ??= mkdir(dirname(this.path), { recursive: true });
    void this.ready.then(() =>
      appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8').catch(() => undefined),
    );
  }
}

/** 把一个长文本切成若干片，模拟逐 token 的增量 */
export function chunkText(text: string, size = 12): string[] {
  if (text === '') return [];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
