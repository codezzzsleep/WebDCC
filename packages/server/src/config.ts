import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parsePublicOrigins } from './auth.js';
import type { DiagnosticWriteLimits } from '@webdcc/model-proxy';

export interface Config {
  host: string;
  port: number;
  token: string;
  dataDir: string;
  dshPort: number;
  idleDisposeMin: number;
  version: string;
  recordInteractions?: boolean;
  diagnosticLimits?: DiagnosticWriteLimits & { retentionMs: number; maxCaptureBytes: number; maxCaptureChunks: number };
  publicOrigins?: string[];
  trustProxy?: boolean | string[];
}

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** SPEC 12.2 的配置项 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env['WDCC_DATA_DIR'] ?? join(homedir(), '.webdcc');
  const recordInteractions = env['WDCC_TRACE'] === '1' && env['WDCC_TEST_HOOKS'] !== '1';
  const limit = (name: string, fallback: number, minimum = 0): number => {
    if (env[name] === undefined || env[name]?.trim() === '') return fallback;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} 必须是至少 ${minimum} 的整数`);
    return value;
  };
  return {
    host: env['WDCC_HOST'] ?? '0.0.0.0',
    port: envInt(env['WDCC_PORT'], 8787),
    token: env['WDCC_TOKEN'] ?? randomBytes(32).toString('base64url'),
    dataDir: resolve(dataDir),
    dshPort: envInt(env['WDCC_DSH_PORT'], 3091),
    idleDisposeMin: envInt(env['WDCC_IDLE_DISPOSE_MIN'], 30),
    version: env['WDCC_VERSION'] ?? '0.1.0',
    publicOrigins: parsePublicOrigins(env['WDCC_PUBLIC_ORIGINS']),
    trustProxy: (env['WDCC_TRUST_PROXY'] ?? '').split(',').map(value => value.trim()).filter(Boolean),
    recordInteractions,
    ...(recordInteractions ? { diagnosticLimits: {
      maxCaptureBytes: limit('WDCC_TRACE_MAX_CAPTURE_BYTES', 8 * 1024 * 1024),
      maxCaptureChunks: limit('WDCC_TRACE_MAX_CAPTURE_CHUNKS', 4096, 1),
      maxFileBytes: limit('WDCC_TRACE_MAX_FILE_BYTES', 64 * 1024 * 1024),
      maxQueuedBytes: limit('WDCC_TRACE_MAX_QUEUED_BYTES', 32 * 1024 * 1024),
      retentionMs: limit('WDCC_TRACE_RETENTION_MS', 7 * 24 * 60 * 60 * 1000, 1),
    } } : {}),
  };
}

/** 带 token 的启动地址（SPEC 12.1） */
export function tokenUrl(config: Config): string {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return `http://${host}:${config.port}/?token=${config.token}`;
}
