/** DSH 连接设置（attach 模式）：只保存 operator Cookie，不保存启动 token（SPEC-M8 2.3） */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface DshConnection {
  url: string;
  cookie: string;
  connectedAt: string;
  version?: string;
}

export class DshConnectionStore {
  private readonly file: string;
  private current: DshConnection | null = null;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'dsh-connection.json');
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    try {
      this.current = JSON.parse(await readFile(this.file, 'utf8')) as DshConnection;
    } catch {
      this.current = null;
    }
  }

  get connection(): DshConnection | null {
    return this.current;
  }

  async save(connection: DshConnection): Promise<void> {
    this.current = connection;
    await writeFile(this.file, JSON.stringify(connection, null, 2), { mode: 0o600 });
    await chmod(this.file, 0o600).catch(() => undefined);
  }

  async clear(): Promise<void> {
    this.current = null;
    await writeFile(this.file, '{}', { mode: 0o600 });
  }
}

/** 从用户粘贴的链接里取出端口与启动 token */
export function parseDshLink(link: string): { url: string; port: number; token: string } {
  const parsed = new URL(link.trim());
  const token = parsed.searchParams.get('token');
  if (token === null || token === '') throw Object.assign(new Error('链接里没有 token'), { statusCode: 400 });
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  return { url: `http://127.0.0.1:${port}`, port, token };
}
