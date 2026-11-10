/**
 * 探针共用：临时工作区、帧录制与脱敏（SPEC M0 第 8 步：原始收发帧脱敏后存 fixtures）。
 */
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface FixtureRecorder {
  record: (direction: 'in' | 'out', frame: unknown) => void;
  flush: () => Promise<void>;
  path: string;
}

/** 造一个 JSONL 录制器；先写临时文件，flush 时统一脱敏落盘 */
export function createFixtureRecorder(repoRelativePath: string): FixtureRecorder {
  const entries: unknown[] = [];
  return {
    path: repoRelativePath,
    record(direction, frame) {
      entries.push({ ts: new Date().toISOString(), direction, frame });
    },
    async flush() {
      const target = join(process.cwd(), repoRelativePath);
      await mkdir(dirname(target), { recursive: true });
      const lines = entries.map((e) => JSON.stringify(sanitize(e))).join('\n');
      await writeFile(target, `${lines}\n`, 'utf8');
    },
  };
}

const SECRET_KEYS = /(api[_-]?key|authorization|token|secret|password|bearer|cookie|signature)/i;

/** 递归脱敏：密钥类字段替换、家目录与主机名替换 */
export function sanitize(value: unknown, keyHint = ''): unknown {
  if (typeof value === 'string') {
    if (SECRET_KEYS.test(keyHint)) return '<redacted>';
    return value
      .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '<redacted-key>')
      .replace(/(gh[ps]_[A-Za-z0-9]{8,})/g, '<redacted-token>')
      .replace(/\bBearer\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>')
      .replace(/\/root\//g, '~/')
      .replace(/\/home\/[a-z0-9_-]+/g, '~/');
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, keyHint));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitize(inner, key);
    }
    return out;
  }
  return value;
}

/** 造一个临时工作区，预置 SPEC.md 供"读文件"动作使用 */
export async function createTempWorkspace(name: string): Promise<string> {
  const dir = join(tmpdir(), `wdcc-probe-${name}-${Date.now().toString(36)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SPEC.md'), '# 探针工作区\n\n这个文件供探针"读文件"动作使用。\n', 'utf8');
  return dir;
}

export async function removeTempWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** 简单断言，失败即抛错（探针以退出码表达成功率） */
export function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`断言失败：${message}`);
}

export function logLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** 小工具：追加一行到日志文件 */
export async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${line}\n`, 'utf8');
}

/** 把 mock 服端录制的请求/响应帧脱敏后写进 fixtures */
export async function dumpMockRecords(source: string, target: string): Promise<void> {
  try {
    const raw = await readFile(source, 'utf8');
    await mkdir(dirname(target), { recursive: true });
    const lines = raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.stringify(sanitize(JSON.parse(line) as unknown)));
    await writeFile(target, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // 没有录制文件时静默跳过
  }
}
