import type { ImportedProvider } from './provider-import.js';
import { readFile, open, rename, rm, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { ProviderDto, ProviderRuntimeConfig } from '@webdcc/protocol';
import { ulid } from '@webdcc/protocol';
import type { ProviderRecord, Store } from './store.js';

export interface ProviderInput {
  name: string;
  baseUrl: string;
  protocols: string[];
  models: string[];
  modelDetails?: { id: string; name: string; reasoningEfforts?: string[] }[];
  apiKey?: string;
  codexCatalogPath?: string;
  endpoints?: Record<string, string>;
  /** 导入来源（manual / codex-config / claude-settings / dsh / paste） */
  source?: string;
  sourceKey?: string;
  /** 缺 Key 时给用户看的原因 */
  missingKeyReason?: string;
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

interface LocalSourceState {
  fingerprint: string;
  currentId: string;
  nativeDefault: boolean;
  nativeDefaultModel?: string;
  changes: Record<string, 'changed' | 'ignored'>;
}
function sourceIdentity(source: string, sourceKey: string | null | undefined): string {
  // Claude has one effective settings env; the old sourceKey was the URL and
  // must not hide URL rotation by pretending it is an unrelated source.
  return source === 'claude-settings' ? source : `${source}:${sourceKey ?? ''}`;
}

/** Provider 注册表 + 密钥文件（0600，SPEC 10.5） */
export class ProviderRegistry {
  private readonly secretsPath: string;
  private readonly ignoredPath: string;
  private secrets: Record<string, string> = {};
  private ignored: string[] = [];

  constructor(
    private readonly store: Store,
    dataDir: string,
  ) {
    this.secretsPath = join(dataDir, 'secrets.json');
    this.ignoredPath = join(dataDir, 'provider-ignored.json');
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.secretsPath), { recursive: true });
    await this.exclusive(async () => {
      this.secrets = await this.readSecrets(true);
    });
    this.ignored = await this.readIgnored();
  }

  private async readIgnored(): Promise<string[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.ignoredPath, 'utf8'));
      if (!Array.isArray(value) || value.some(key => typeof key !== 'string')) throw new Error('Provider 忽略列表格式无效');
      return value as string[];
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- JSON parser causes may contain credential material.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取 Provider 忽略列表；原文件已保留');
      return [];
    }
  }

  private static readonly writes = new Map<string, Promise<unknown>>();

  /** Serialize local writers; a second process must never overwrite a stale snapshot.
   * A crash leaves the lock in place for explicit operator recovery, not blind stealing. */
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const prior = ProviderRegistry.writes.get(this.secretsPath) ?? Promise.resolve();
    const pending = prior.catch(() => undefined).then(async () => {
      let lock;
      try { lock = await open(`${this.secretsPath}.lock`, 'wx', 0o600); }
      catch { throw Object.assign(new Error('Provider 凭据正在写入或上次写入未完成；请检查凭据锁'), { statusCode: 409 }); }
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        await lock.sync();
        return await action();
      }
      finally { await lock.close(); await rm(`${this.secretsPath}.lock`); }
    });
    ProviderRegistry.writes.set(this.secretsPath, pending);
    void pending.finally(() => { if (ProviderRegistry.writes.get(this.secretsPath) === pending) ProviderRegistry.writes.delete(this.secretsPath); }).catch(() => undefined);
    return pending;
  }

  private async readSecrets(initialize = false): Promise<Record<string, string>> {
    let raw: string;
    try { raw = await readFile(this.secretsPath, 'utf8'); }
    catch (error) {
      if (initialize && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.persist({});
        return {};
      }
      // eslint-disable-next-line preserve-caught-error -- Do not attach potentially secret-bearing IO diagnostics.
      throw new Error('无法读取 Provider 凭据；原文件已保留');
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (value === null || typeof value !== 'object' || Array.isArray(value)
        || Object.entries(value).some(([key, secret]) => key === '' || ['__proto__', 'constructor', 'prototype'].includes(key) || typeof secret !== 'string')) throw new Error();
      return value as Record<string, string>;
    } catch { throw new Error('Provider 凭据文件格式无效；原文件已保留'); }
  }

  private async atomicWrite(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }


  /** 从本机配置导入（F16）：去重后写入，已忽略的来源不再导入 */
  private scanning: Promise<unknown> = Promise.resolve();
  private readonly observedCandidates = new Map<string, ImportedProvider>();
  private localState(): Record<string, LocalSourceState> {
    const raw = this.store.providerLocalState();
    return raw === undefined ? {} : JSON.parse(raw) as Record<string, LocalSourceState>;
  }

  async scanLocal(): Promise<{ imported: number; skipped: number }> {
    const pending = this.scanning.catch(() => undefined).then(() => this.scanCandidates());
    this.scanning = pending;
    return pending;
  }

  private async scanCandidates(): Promise<{ imported: number; skipped: number }> {
    const { scanLocalProviders } = await import('./provider-import.js');
    const candidates = await scanLocalProviders();
    this.observedCandidates.clear();
    this.ignored = await this.readIgnored();
    const states = this.localState();
    let imported = 0; let skipped = 0;
    for (const candidate of candidates) {
      const identity = sourceIdentity(candidate.source, candidate.sourceKey);
      this.observedCandidates.set(identity, candidate);
      if (this.ignored.includes(`${candidate.source}:${candidate.sourceKey}`)) { skipped++; continue; }
      const normalized = candidate.baseUrl.replace(/\/+$/, '');
      const keyHash = createHash('sha256').update(candidate.apiKey ?? '').digest('hex');
      const fingerprint = createHash('sha256').update(JSON.stringify({ ...candidate, apiKey: keyHash, baseUrl: normalized })).digest('hex');
      const secrets = await this.readSecrets();
      const matches = this.store.listProviders().filter(row => row.source !== 'manual' && row.baseUrl.replace(/\/+$/, '') === normalized
        && createHash('sha256').update(secrets[row.secretRef] ?? '').digest('hex') === keyHash);
      // Address+key dedup remains unchanged. Prefer the explicitly updated
      // source row when more than one legacy record already matches.
      const existing = matches.find(row => row.id === states[identity]?.currentId) ?? matches[0];
      let currentId: string;
      if (existing !== undefined) {
        currentId = existing.id; skipped++;
        this.store.updateProvider(existing.id, { protocols: [...new Set([...existing.protocols, ...candidate.protocols])] });
        // Never overwrite edited fields during a scan. Native defaults are
        // exposed separately; the explicit update action merges native models.
      } else {
        const endpoints = Object.fromEntries(candidate.protocols.map(protocol => [protocol, normalized]));
        const created = await this.create({ ...candidate, endpoints });
        currentId = created.id; imported++;
      }
      const previous = states[identity];
      const changed = previous === undefined || previous.fingerprint !== fingerprint || previous.currentId !== currentId;
      const changes: LocalSourceState['changes'] = changed ? {} : { ...previous.changes };
      for (const row of this.store.listProviders()) {
        if (row.source === 'manual' || sourceIdentity(row.source, row.sourceKey) !== identity) continue;
        if (row.id !== currentId && (changed || changes[row.id] === undefined)) changes[row.id] = 'changed';
      }
      if (previous !== undefined && previous.fingerprint !== fingerprint && previous.currentId === currentId) changes[currentId] = 'changed';
      states[identity] = { fingerprint, currentId, changes, nativeDefault: candidate.nativeDefault === true,
        ...(candidate.nativeDefaultModel === undefined ? {} : { nativeDefaultModel: candidate.nativeDefaultModel }) };
    }
    this.store.saveProviderLocalState(JSON.stringify(states));
    return { imported, skipped };
  }

  async resolveLocalChange(id: string, action: 'update' | 'ignore'): Promise<ProviderDto | undefined> {
    // Reread native config so an old button cannot apply a stale credential.
    await this.scanLocal();
    const row = this.store.getProvider(id);
    if (row === undefined) return undefined;
    const identity = sourceIdentity(row.source, row.sourceKey);
    const states = this.localState(); const state = states[identity]; const candidate = this.observedCandidates.get(identity);
    if (state === undefined || state.changes[id] === undefined || candidate === undefined) throw Object.assign(new Error('没有可处理的本机配置变化，请重新扫描'), { statusCode: 409 });
    if (action === 'ignore') state.changes[id] = 'ignored';
    else {
      await this.update(id, { baseUrl: candidate.baseUrl, apiKey: candidate.apiKey ?? '',
        endpoints: Object.fromEntries(candidate.protocols.map(protocol => [protocol, candidate.baseUrl])),
        protocols: [...new Set([...row.protocols, ...candidate.protocols])], models: [...new Set([...row.models, ...candidate.models])],
        ...(candidate.codexCatalogPath === undefined ? {} : { codexCatalogPath: candidate.codexCatalogPath }) });
      // Name, custom model labels/levels and explicit browser choices survive.
      state.currentId = id; delete state.changes[id];
    }
    this.store.saveProviderLocalState(JSON.stringify(states));
    return this.get(id);
  }

  async restoreIgnored(): Promise<void> {
    await this.exclusive(async () => {
      await this.atomicWrite(this.ignoredPath, []);
      this.ignored = [];
    });
  }

  isIgnored(sourceKey: string): boolean {
    return this.ignored.includes(sourceKey);
  }

  private async persist(value: Record<string, string>): Promise<void> {
    await this.atomicWrite(this.secretsPath, value);
  }

  /** Only reclaim references already unreachable in SQL. Staged keys from an
   * interrupted SQL commit cannot destroy credentials of any existing Provider. */
  private reachableSecrets(value: Record<string, string>): Record<string, string> {
    const refs = new Set(this.store.listProviders().map(row => row.secretRef));
    return Object.fromEntries(Object.entries(value).filter(([ref]) => refs.has(ref)));
  }

  list(): ProviderDto[] {
    return this.store.listProviders().map((row) => this.toDto(row));
  }

  get(id: string): ProviderDto | undefined {
    const row = this.store.getProvider(id);
    return row === undefined ? undefined : this.toDto(row);
  }

  private toDto(row: ProviderRecord): ProviderDto {
    const states = this.localState();
    const state = states[sourceIdentity(row.source, row.sourceKey)];
    const nativeDefaults = Object.fromEntries(Object.entries(states).flatMap(([source, item]) => item.currentId === row.id && item.nativeDefault && item.nativeDefaultModel !== undefined
      ? [[source.startsWith('codex-config:') ? 'codex' : source === 'claude-settings' ? 'claude-code' : source, item.nativeDefaultModel]] : []));
    const localChange = state?.changes[row.id];
    return {
      ...(Object.keys(nativeDefaults).length === 0 ? {} : { nativeDefaults }),
      ...(state === undefined ? {} : { nativeDefault: state.nativeDefault && state.currentId === row.id, ...(state.currentId !== row.id || state.nativeDefaultModel === undefined ? {} : { nativeDefaultModel: state.nativeDefaultModel }) }),
      ...(localChange === undefined || state === undefined ? {} : { localChange: { status: localChange, replacementId: state.currentId } }),
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      ...(row.endpoints === null ? {} : { endpoints: JSON.parse(row.endpoints) as Record<string, string> }),
      protocols: row.protocols,
      models: row.models,
      modelDetails: row.modelDetails,
      source: row.source,
      ...(row.endpoints === null ? {} : { endpoints: JSON.parse(row.endpoints) as Record<string, string> }),
      ...(row.sourceKey === null ? {} : { sourceKey: row.sourceKey }),
      ...(row.codexCatalogPath === null ? {} : { codexCatalogPath: row.codexCatalogPath }),
      hasKey: this.secrets[row.secretRef] !== undefined,
      ...(this.secrets[row.secretRef] === undefined ? {} : { keyHint: (this.secrets[row.secretRef] ?? '').slice(-4) }),
      ...(row.note === null ? {} : { note: row.note }),
      createdAt: row.createdAt,
    };
  }

  async create(input: ProviderInput): Promise<ProviderDto> {
    return this.exclusive(async () => {
      if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw Object.assign(new Error('API Key 必须是字符串'), { statusCode: 400 });
      const next = this.reachableSecrets(await this.readSecrets());
      const id = ulid();
      const secretRef = `provider:${id}`;
      if (input.apiKey !== undefined && input.apiKey !== '') next[secretRef] = input.apiKey;
      await this.persist(next);
      this.store.createProvider({
        id,
        name: input.name,
        baseUrl: input.baseUrl,
        protocols: input.protocols,
        models: input.models,
        modelDetails: input.modelDetails,
        secretRef,
        codexCatalogPath: input.codexCatalogPath ?? null,
        source: input.source ?? 'manual',
        sourceKey: input.sourceKey ?? null,
        endpoints: input.endpoints === undefined ? null : JSON.stringify(input.endpoints),
        note: input.missingKeyReason ?? null,
      });
      this.secrets = next;
      return this.get(id) as ProviderDto;
    });
  }

  async update(id: string, patch: Partial<ProviderInput>): Promise<ProviderDto | undefined> {
    return this.exclusive(async () => {
      if (patch.apiKey !== undefined && typeof patch.apiKey !== 'string') throw Object.assign(new Error('API Key 必须是字符串'), { statusCode: 400 });
      const next = this.reachableSecrets(await this.readSecrets());
      const row = this.store.getProvider(id);
      if (row === undefined) return undefined;
      // Changing an immutable reference makes file-before-SQL crash recovery safe.
      const secretRef = patch.apiKey === undefined ? row.secretRef : `provider:${id}:${ulid()}`;
      if (patch.apiKey !== undefined && patch.apiKey !== '') next[secretRef] = patch.apiKey;
      await this.persist(next);
      this.store.updateProvider(id, {
        secretRef,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.baseUrl === undefined ? {} : { baseUrl: patch.baseUrl }),
        ...(patch.endpoints === undefined ? {} : { endpoints: JSON.stringify(patch.endpoints) }),
        ...(patch.protocols === undefined ? {} : { protocols: patch.protocols }),
        ...(patch.models === undefined ? {} : { models: patch.models }),
        ...(patch.modelDetails === undefined ? {} : { modelDetails: patch.modelDetails }),
        ...(patch.codexCatalogPath === undefined ? {} : { codexCatalogPath: patch.codexCatalogPath }),
      });
      this.secrets = next;
      return this.get(id);
    });
  }

  async remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      const next = this.reachableSecrets(await this.readSecrets());
      const row = this.store.getProvider(id);
      if (row === undefined) return;
      this.store.assertProviderUnused(id);
      const previousIgnored = await this.readIgnored();
      const source = row.sourceKey !== null && row.source !== 'manual' ? `${row.source}:${row.sourceKey}` : undefined;
      const nextIgnored = source === undefined || previousIgnored.includes(source) ? previousIgnored : [...previousIgnored, source];
      // Publish the deletion's import suppression first. A failure must not
      // delete SQL and then silently reimport this source on the next scan.
      await this.atomicWrite(this.ignoredPath, nextIgnored);
      try { this.store.deleteProvider(id); }
      catch (error) { await this.atomicWrite(this.ignoredPath, previousIgnored); throw error; }
      this.ignored = nextIgnored;
      delete next[row.secretRef];
      await this.persist(next);
      this.secrets = next;
    });
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
      ...(row.endpoints === null ? {} : { endpoints: JSON.parse(row.endpoints) as Record<string, string> }),
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
    const dto = this.toDto(row); const model = dto.nativeDefaults?.[agent] ?? (row.source === (agent === 'codex' ? 'codex-config' : 'claude-settings') ? dto.nativeDefaultModel : undefined);
    return [...new Set([...row.models, ...(model === undefined ? [] : [model])])];
  }
}
