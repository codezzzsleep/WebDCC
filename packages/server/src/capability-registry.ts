import { createHash } from 'node:crypto';
import { hostname, platform } from 'node:os';
import type { Capability, CapabilityRuntime, CapabilitySnapshot, NativeMethodInventoryEntry, ProbeResult } from '@webdcc/protocol';
import nativeInventory from './native-inventory.json' with { type: 'json' };
import type { SessionManager } from './manager.js';
import type { Store } from './store.js';

const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const titles: Record<string, string> = {
  thread: '会话、历史与分叉', turn: '轮次、输入与停止', item: '工具、审批与问答', account: '账号与登录', model: '模型目录', mcpServer: 'MCP 服务与认证',
  session: '会话与历史', agent: 'Agent 控制', settings: '原生设置', configuration: '启动设置', interrupt: '停止当前轮次', setPermissionMode: '切换权限', setModel: '切换模型',
  'native-cli': '原生 CLI', 'native-web': '原生 Web',
};

/** Every native method remains inventoried even when this client has no UI for it. */
export const frozenNativeInventory = nativeInventory.entries as NativeMethodInventoryEntry[];

export class CapabilityRegistry {
  constructor(private readonly store: Store, private readonly manager: SessionManager) {}

  async snapshot(workspaceId: string | null = null): Promise<CapabilitySnapshot> {
    if (workspaceId !== null && this.store.getWorkspace(workspaceId) === undefined) throw Object.assign(new Error('工作区不存在'), { statusCode: 404 });
    const runtimes: CapabilityRuntime[] = [];
    const capabilities: Capability[] = [];
    const providers = this.store.listProviders().map(provider => ({ id: provider.id, models: provider.models, details: provider.modelDetails }));
    for (const adapter of this.manager.adaptersList()) {
      const probe: ProbeResult = await adapter.probe().catch(() => ({ installed: false, pinnedVersion: nativeInventory.baseline[adapter.id], auth: 'unknown' as const, notes: ['原生探测失败'] }));
      const kind = adapter.kind ?? 'real';
      const expected = nativeInventory.baseline[adapter.id];
      const compatibility = kind === 'fake' ? 'test-only' : probe.version === undefined ? 'unknown' : probe.version === expected ? 'compatible' : 'incompatible';
      const source = nativeInventory.sources[adapter.id === 'claude-code' ? 'claude' : adapter.id];
      runtimes.push({ agent: adapter.id, hostId: fingerprint({ hostname: hostname(), agent: adapter.id }).slice(0, 24), os: platform(), profile: 'native-default', probe, adapterKind: kind, compatibility, schemaHash: source.sha256, configurationFingerprint: fingerprint({ providers, workspaceId }), pluginStatus: 'unverified' });
      const groups = new Map<string, NativeMethodInventoryEntry[]>();
      for (const entry of frozenNativeInventory.filter(entry => entry.agent === adapter.id && entry.role !== 'internal')) {
        const group = groups.get(entry.capabilityId) ?? [];
        group.push(entry);
        groups.set(entry.capabilityId, group);
      }
      for (const [id, entries] of groups) {
        const surface = id.endsWith('.native-cli') || id.endsWith('.native-web');
        const suffix = id.split('.').slice(1).join('.');
        capabilities.push({ id, agent: adapter.id, title: titles[suffix] ?? `原生 ${suffix} 能力`, methods: entries.map(entry => entry.method),
          nativeAvailability: !probe.installed || probe.auth === 'missing' ? 'environment-blocked' : compatibility === 'compatible' ? 'available' : 'unknown',
          apiExposure: surface ? 'unsupported-in-api' : compatibility === 'compatible' ? 'public' : 'unverified',
          structuredImplemented: false, structuredVerified: false, fallbackVerified: false,
          reason: compatibility === 'incompatible' ? `实际版本 ${probe.version} 与基线 ${expected} 不兼容` : surface ? '原生入口待实现与同会话验证' : '已列入原生库存；结构化操作与配置/插件状态须逐项验证', evidence: [],
        });
      }
    }
    const content = { formatVersion: 1 as const, workspaceId, runtimes, capabilities, inventory: frozenNativeInventory };
    const snapshot = { ...content, revision: fingerprint(content), observedAt: new Date().toISOString() };
    this.store.saveCapabilitySnapshot(workspaceId ?? '*', snapshot.revision, snapshot);
    return snapshot;
  }

  async assertRevision(revision: string, workspaceId: string | null = null): Promise<CapabilitySnapshot> {
    const snapshot = await this.snapshot(workspaceId);
    if (snapshot.revision !== revision) throw Object.assign(new Error('原生能力或配置已变化，请刷新后重试'), { statusCode: 409, code: 'capability-stale' });
    return snapshot;
  }
}
