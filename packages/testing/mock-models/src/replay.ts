import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface ReplayChunk { t: number; data: string; }
export interface ReplayResponse { status: number; headers?: Record<string, string | string[]>; chunks: ReplayChunk[]; }
export interface ReplayRecord { request?: unknown; response: ReplayResponse; }

/** Protocol-neutral model response replayer. It matches request order and
 * fails loudly when an Agent makes a different number of calls. */
export class ModelReplayServer {
  private server: Server | null = null;
  private index = 0;
  constructor(private readonly records: ReplayRecord[], private readonly speed = 1) {}

  async listen(port = 0, host = '127.0.0.1'): Promise<{ url: string; port: number }> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(port, host, () => resolve());
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('replay server address unavailable');
    return { url: `http://${host}:${address.port}`, port: address.port };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }

  private async handle(_request: IncomingMessage, response: ServerResponse): Promise<void> {
    const record = this.records[this.index];
    if (record === undefined) {
      response.statusCode = 500;
      response.end(`model replay exhausted at request ${this.index + 1}`);
      return;
    }
    this.index += 1;
    for (const [name, value] of Object.entries(record.response.headers ?? {})) response.setHeader(name, value);
    response.writeHead(record.response.status);
    let previous = 0;
    for (const chunk of record.response.chunks) {
      const delay = Math.max(0, Math.round((chunk.t - previous) / this.speed));
      previous = chunk.t;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      response.write(Buffer.from(chunk.data, 'base64'));
    }
    response.end();
  }
}
