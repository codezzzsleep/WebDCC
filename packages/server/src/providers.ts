import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProviderDto, ProviderRuntimeConfig } from '@webdcc/protocol';
import { ulid } from '@webdcc/protocol';
import type { ProviderRecord, Store } from './store.js';

export interface ProviderInput {
  name: string;
  baseUrl: string;
  protocols: string[];
  models: string[];
  apiKey?: string;
  codexCatalogPath?: string;
}

export const AGENT_PROTOCOLS: Record<string, string[]> = {
  codex: ['openai-responses'],
  'claude-code': ['anthropic-messages'],
  dsh: [],
};

/** 协议兼容矩阵（SPEC 10.2） */
export function isCompatible(agent: string, protocols: string[]): boolean {
  const needs = AGENT_PROTOCOLS[agent] ?? [];
  if (needs.length === 0) return false;
  return needs.some((protocol) => protocols.includes(protocol));
}

/** Provider 注册表 + 密钥文件（0600，SPEC 10.5） */
export class ProviderRegistry {
  private readonly secretsPath: string;
  private secrets: Record<string, string> = {};

  constructor(
    private readonly store: Store,
    dataDir: string,
  ) {
    this.secretsPath = join(dataDir, 'secrets.json');
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.secretsPath), { recursive: true });
    try {
      this.secrets = JSON.parse(await readFile(this.secretsPath, 'utf8')) as Record<string, string>;
    } catch {
      this.secrets = {};
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    await writeFile(this.secretsPath, JSON.stringify(this.secrets, null, 2), { mode: 0o600 });
    await chmod(this.secretsPath, 0o600).catch(() => undefined);
  }

  list(): ProviderDto[] {
    return this.store.listProviders().map((row) => this.toDto(row));
  }

  get(id: string): ProviderDto | undefined {
    const row = this.store.getProvider(id);
    return row === undefined ? undefined : this.toDto(row);
  }

  private toDto(row: ProviderRecord): ProviderDto {
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      protocols: row.protocols,
      models: row.models,
      ...(row.codexCatalogPath === null ? {} : { codexCatalogPath: row.codexCatalogPath }),
      hasKey: this.secrets[row.secretRef] !== undefined,
      createdAt: row.createdAt,
    };
  }

  async create(input: ProviderInput): Promise<ProviderDto> {
    const id = ulid();
    const secretRef = `provider:${id}`;
    if (input.apiKey !== undefined && input.apiKey !== '') this.secrets[secretRef] = input.apiKey;
    await this.persist();
    this.store.createProvider({
      id,
      name: input.name,
      baseUrl: input.baseUrl,
      protocols: input.protocols,
      models: input.models,
      secretRef,
      codexCatalogPath: input.codexCatalogPath ?? null,
    });
    return this.get(id) as ProviderDto;
  }

  async update(id: string, patch: Partial<ProviderInput>): Promise<ProviderDto | undefined> {
    const row = this.store.getProvider(id);
    if (row === undefined) return undefined;
    if (patch.apiKey !== undefined) {
      if (patch.apiKey === '') delete this.secrets[row.secretRef];
      else this.secrets[row.secretRef] = patch.apiKey;
      await this.persist();
    }
    this.store.updateProvider(id, {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.baseUrl === undefined ? {} : { baseUrl: patch.baseUrl }),
      ...(patch.protocols === undefined ? {} : { protocols: patch.protocols }),
      ...(patch.models === undefined ? {} : { models: patch.models }),
      ...(patch.codexCatalogPath === undefined ? {} : { codexCatalogPath: patch.codexCatalogPath }),
    });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const row = this.store.getProvider(id);
    if (row === undefined) return;
    delete this.secrets[row.secretRef];
    await this.persist();
    this.store.deleteProvider(id);
  }

  /** 会话创建时解析出运行期配置（含密钥，只在内存里传给 adapter） */
  runtimeConfig(id: string | null | undefined): ProviderRuntimeConfig | null {
    if (id === null || id === undefined) return null;
    const row = this.store.getProvider(id);
    if (row === undefined) return null;
    const apiKey = this.secrets[row.secretRef];
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      protocols: row.protocols,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(row.codexCatalogPath === null ? {} : { codexCatalogPath: row.codexCatalogPath }),
    };
  }

  /** 供 /api/models 用：只返回模型 id，不碰密钥 */
  modelsFor(agent: string, providerId: string | null): string[] {
    if (providerId === null) return [];
    const row = this.store.getProvider(providerId);
    if (row === undefined) return [];
    if (!isCompatible(agent, row.protocols)) return [];
    return row.models;
  }
}
