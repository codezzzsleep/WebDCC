import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as requestHttps } from 'node:https';
import { request as requestHttp } from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ModelProxyChunk { t: number; data: string; }
export interface ModelProxyRecord {
  i: number;
  t: number;
  request: { method: string; path: string; headers: IncomingHttpHeaders; body: string };
  response: { status: number; headers: Record<string, string | string[] | undefined>; chunks: ModelProxyChunk[] };
}
export interface ModelProxyOptions {
  target: string;
  host?: string;
  port?: number;
  recordFile?: string;
  speed?: number;
}

function bodyOf(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function targetRequest(target: URL, req: IncomingMessage, body: Buffer): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; chunks: ModelProxyChunk[] }> {
  const transport = target.protocol === 'https:' ? requestHttps : requestHttp;
  const upstreamUrl = new URL(req.url ?? '/', target);
  return new Promise((resolve, reject) => {
    const upstream = transport(target, {
      method: req.method,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      headers: { ...req.headers, host: target.host, 'content-length': body.byteLength },
    }, (response) => {
      const started = Date.now();
      const chunks: ModelProxyChunk[] = [];
      response.on('data', (chunk: Buffer | string) => chunks.push({ t: Date.now() - started, data: Buffer.from(chunk).toString('base64') }));
      response.on('end', () => resolve({ status: response.statusCode ?? 502, headers: response.headers, chunks }));
      response.on('error', reject);
    });
    upstream.on('error', reject);
    upstream.end(body);
  });
}

export class ModelProxy {
  private server: Server | null = null;
  private readonly target: URL;
  private readonly options: ModelProxyOptions;
  private seq = 0;
  private readonly started = Date.now();

  constructor(options: ModelProxyOptions) {
    this.options = options;
    this.target = new URL(options.target);
  }

  async listen(): Promise<{ host: string; port: number; url: string }> {
    if (this.server !== null) throw new Error('model proxy already listening');
    await mkdir(this.options.recordFile === undefined ? '/tmp' : dirname(this.options.recordFile), { recursive: true });
    const host = this.options.host ?? '127.0.0.1';
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.options.port ?? 0, host, () => resolve());
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('proxy address unavailable');
    return { host, port: address.port, url: `http://${host}:${address.port}` };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await bodyOf(req);
    const started = Date.now();
    try {
      const response = await targetRequest(this.target, req, body);
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) res.setHeader(key, value);
      res.writeHead(response.status);
      for (const chunk of response.chunks) {
        const delay = Math.max(0, Math.round(chunk.t / (this.options.speed ?? 1)) - (Date.now() - started));
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        res.write(Buffer.from(chunk.data, 'base64'));
      }
      res.end();
      if (this.options.recordFile !== undefined) {
        const record: ModelProxyRecord = {
          i: ++this.seq,
          t: Date.now() - this.started,
          request: { method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body: body.toString('base64') },
          response,
        };
        await appendFile(this.options.recordFile, `${JSON.stringify(record)}\n`);
      }
    } catch (error) {
      res.statusCode = 502;
      res.end(error instanceof Error ? error.message : String(error));
    }
  }
}

export async function startModelProxy(options: ModelProxyOptions): Promise<ModelProxy & { address: { host: string; port: number; url: string } }> {
  const proxy = new ModelProxy(options) as ModelProxy & { address: { host: string; port: number; url: string } };
  proxy.address = await proxy.listen();
  return proxy;
}
