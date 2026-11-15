/** DSH attach 保存原生 operator/browser Cookie，绝不保存启动 token。 */
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { dshBaseUrl } from '@webdcc/adapter-dsh';

export interface DshConnection {
  url: string;
  cookie: string;
  /** Native v1 browser peer survives a physical WS reconnect; server-only. */
  browserCookie?: string;
  connectedAt: string;
  version?: string;
}

function parseConnection(value: unknown): DshConnection | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<DshConnection>;
  if (typeof candidate.url !== 'string' || typeof candidate.cookie !== 'string' || candidate.cookie.length === 0 || candidate.cookie.length > 16384 || [...candidate.cookie].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) > 126)) return null;
  if (candidate.browserCookie !== undefined && (typeof candidate.browserCookie !== 'string' || !/^dsh-auth-[^=;]+=v1\./.test(candidate.browserCookie) || candidate.browserCookie.length > 16384 || [...candidate.browserCookie].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) > 126))) return null;
  if (typeof candidate.connectedAt !== 'string' || !Number.isFinite(Date.parse(candidate.connectedAt)) || candidate.version !== undefined && typeof candidate.version !== 'string') return null;
  try { return { url: dshBaseUrl(candidate.url), cookie: candidate.cookie, connectedAt: candidate.connectedAt, ...(candidate.browserCookie === undefined ? {} : { browserCookie: candidate.browserCookie }), ...(candidate.version === undefined ? {} : { version: candidate.version }) }; } catch { return null; }
}

export class DshConnectionStore {
  private readonly file: string;
  private current: DshConnection | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = join(dataDir, 'dsh-connection.json');
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    try {
      this.current = parseConnection(JSON.parse(await readFile(this.file, 'utf8')));
    } catch {
      this.current = null;
    }
  }

  get connection(): DshConnection | null {
    return this.current === null ? null : { ...this.current };
  }

  async save(connection: DshConnection): Promise<void> {
    const parsed = parseConnection(connection);
    if (parsed === null) throw Object.assign(new Error('DSH 连接字段无效'), { statusCode: 400 });
    await this.enqueue(parsed);
  }

  async clear(): Promise<void> {
    await this.enqueue(null);
  }

  private enqueue(value: DshConnection | null): Promise<void> {
    const pending = this.writing.catch(() => undefined).then(async () => { await this.persist(value); this.current = value; });
    this.writing = pending;
    return pending;
  }

  private async persist(value: DshConnection | null): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.file);
      const directory = await open(dirname(this.file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    finally { await rm(temporary, { force: true }); }
  }
}

/** 从用户粘贴的链接里取出端口与启动 token */
export function parseDshLink(link: string): { url: string; port: number; token: string } {
  const parsed = new URL(link.trim());
  const token = parsed.searchParams.get('token');
  if (token === null || token === '') throw Object.assign(new Error('链接里没有 token'), { statusCode: 400 });
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  return { url: dshBaseUrl(parsed.toString()), port, token };
}
