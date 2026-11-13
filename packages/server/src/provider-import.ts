/**
 * F16：从本机已有配置只读导入 Provider（不写回任何 Agent 配置）。
 * - Codex：codex app-server 的 config/read（合并后的生效配置）
 * - Claude：settings.json 的 env 段
 * - DSH：读取类端点（下一步）
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderInput } from './providers.js';

export interface ImportedProvider extends ProviderInput {
  source: 'codex-config' | 'claude-settings' | 'dsh';
  sourceKey: string;
}

export async function codexConfigRead(cwd = process.cwd()): Promise<Record<string, unknown> | null> {
  const { JsonRpcStdio } = await import('@webdcc/adapter-codex');
  // 读的是用户本机生效的 Codex 配置：CODEX_HOME 没设时就是 Codex 自己的默认位置（~/.codex），不能换成空的临时目录
  const rpc = JsonRpcStdio.start({ command: 'codex', args: ['app-server'], env: { ...process.env } });
  try {
    await rpc.request('initialize', { clientInfo: { name: 'webdcc', title: 'WebDCC import', version: '0.1.0' }, capabilities: null });
    rpc.notify('initialized');
    const result = (await rpc.request('config/read', { cwd })) as { config?: Record<string, unknown> } | Record<string, unknown>;
    return (result as { config?: Record<string, unknown> }).config ?? (result as Record<string, unknown>);
  } catch {
    return null;
  } finally {
    await rpc.kill().catch(() => undefined);
  }
}

/** Codex：导出 provider 列表（跳过 requires_openai_auth，即原生 ChatGPT 登录） */
export async function importFromCodex(): Promise<ImportedProvider[]> {
  const config = await codexConfigRead();
  if (config === null) return [];
  const providers = (config['model_providers'] ?? {}) as Record<string, Record<string, unknown>>;
  const topModel = typeof config['model'] === 'string' ? config['model'] : undefined;
  const topProvider = typeof config['model_provider'] === 'string' ? config['model_provider'] : undefined;
  const profiles = (config['profiles'] ?? {}) as Record<string, Record<string, unknown>>;
  const out: ImportedProvider[] = [];
  for (const [id, provider] of Object.entries(providers)) {
    if (provider['requires_openai_auth'] === true) continue;
    const baseUrl = typeof provider['base_url'] === 'string' ? provider['base_url'] : undefined;
    if (baseUrl === undefined) continue;
    const envKey = typeof provider['env_key'] === 'string' ? provider['env_key'] : undefined;
    const bearer = typeof provider['experimental_bearer_token'] === 'string' ? provider['experimental_bearer_token'] : undefined;
    const envValue = envKey === undefined ? undefined : process.env[envKey];
    const key = bearer ?? (envValue === undefined || envValue === '' ? undefined : envValue);
    const models = new Set<string>();
    if (topProvider === id && topModel !== undefined) models.add(topModel);
    for (const profile of Object.values(profiles)) {
      if (profile['model_provider'] === id && typeof profile['model'] === 'string') models.add(profile['model']);
    }
    out.push({
      name: typeof provider['name'] === 'string' ? provider['name'] : id,
      baseUrl,
      protocols: ['openai-responses'],
      models: [...models],
      ...(key === undefined ? {} : { apiKey: key }),
      source: 'codex-config',
      sourceKey: id,
      ...(typeof provider['model_catalog_json'] === 'string' ? { codexCatalogPath: provider['model_catalog_json'] } : {}),
    });
    if (key === undefined && envKey !== undefined) {
      out[out.length - 1]!.missingKeyReason = `缺少 Key（本机配置读取环境变量 ${envKey}）`;
    }
  }
  return out;
}

/** Claude Code：读 settings.json 的 env 段 */
export async function importFromClaude(): Promise<ImportedProvider[]> {
  const configDir = process.env['CLAUDE_CONFIG_DIR'] ?? join(process.env['HOME'] ?? homedir(), '.claude');
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return [];
  }
  // 和 Claude Code 自己一样：settings.json 的 env 盖过进程环境变量
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
    ...(settings['env'] as Record<string, string> | undefined),
  } as Record<string, string>;
  const baseUrl = env['ANTHROPIC_BASE_URL'];
  if (baseUrl === undefined || baseUrl === '') return [];
  const key = env['ANTHROPIC_AUTH_TOKEN'] ?? env['ANTHROPIC_API_KEY'];
  const models = [env['ANTHROPIC_MODEL'], env['ANTHROPIC_SMALL_FAST_MODEL'], env['ANTHROPIC_DEFAULT_OPUS_MODEL'], env['ANTHROPIC_DEFAULT_SONNET_MODEL'], env['ANTHROPIC_DEFAULT_HAIKU_MODEL']]
    .filter((model): model is string => model !== undefined && model !== '');
  return [
    {
      name: 'Claude 设置里的端点',
      baseUrl,
      protocols: ['anthropic-messages'],
      models: [...new Set(models)],
      ...(key === undefined || key === '' ? { missingKeyReason: '缺少 Key（本机 settings.json 未提供）' } : { apiKey: key }),
      source: 'claude-settings',
      sourceKey: baseUrl,
    },
  ];
}

export async function scanLocalProviders(): Promise<ImportedProvider[]> {
  const results = await Promise.all([importFromCodex().catch(() => []), importFromClaude().catch(() => [])]);
  return results.flat();
}
