/** AgentAdapter 统一接口（SPEC 5.1） */
import type { EventKind } from './events.js';

export type AgentId = 'dsh' | 'codex' | 'claude-code';

export interface ProbeResult {
  installed: boolean;
  version?: string;
  pinnedVersion: string;
  auth: 'ok' | 'missing' | 'unknown';
  notes?: string[];
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface ProviderRuntimeConfig {
  id: string;
  name: string;
  baseUrl: string;
  endpoints?: Record<string, string>;
  protocols: string[];
  /** 只在启动子进程/构造 SDK 环境时使用，绝不落库明文或返回给前端 */
  apiKey?: string;
  codexCatalogPath?: string;
}

export interface CreateOpts {
  sessionId: string;
  cwd: string;
  providerId: string | null;
  /** providerId 对应的解析结果；null = 原生登录/原生配置 */
  provider?: ProviderRuntimeConfig | null;
  model?: string;
  accessMode?: string;
}

export interface UserInput {
  text: string;
  images?: { fileId: string; path: string; mime: string }[];
}

export interface ApprovalDecision {
  approvalId: string;
  optionId: string;
}

export interface LaunchSpec {
  command?: string;
  args?: string[];
  env: Record<string, string>;
  sdkOptions?: Record<string, unknown>;
  startParams?: Record<string, unknown>;
}

export type AdapterEvent =
  | { type: 'item.start'; itemKey: string; kind: EventKind; data: unknown; turnId?: string; native?: unknown }
  | { type: 'item.delta'; itemKey: string; field: 'text' | 'output'; append: string }
  | { type: 'item.update'; itemKey: string; data: unknown }
  | { type: 'item.complete'; itemKey: string; kind: EventKind; data: unknown; turnId?: string; native?: unknown; nativeSeq?: number }
  | { type: 'status'; status: 'running' | 'waiting' | 'idle' | 'error' }
  /** 原生 id 迟到（Claude Code 要等首条消息才有 session_id）：manager 收到后落库 */
  | { type: 'native-id'; nativeId: string };

export interface AgentProcessInfo {
  sessionId: string;
  pid: number;
  /** 进程环境里与本 Agent 相关的目录变量（测试断言用） */
  dirs?: Record<string, string>;
}

export interface AgentAdapter {
  id: AgentId;
  /** real = 原生 Agent；fake = 假 adapter（只在快速 e2e 里出现） */
  kind?: 'real' | 'fake';
  /** 测试钩子用：列出本 adapter 启动的进程 */
  debugProcesses?(): AgentProcessInfo[];
  probe(): Promise<ProbeResult>;
  listModels(providerId: string | null): Promise<ModelOption[]>;
  accessModes(): { id: string; label: string }[];
  /** 运行时可用的访问模式（Codex 从 permissionProfile/list 读，MODE-codex-01） */
  listAccessModes?(): Promise<{ id: string; label: string }[]>;
  buildLaunchSpec(opts: CreateOpts): LaunchSpec;
  create(opts: CreateOpts): Promise<{ nativeId: string }>;
  resume(opts: CreateOpts & { nativeId: string }): Promise<void>;
  send(sessionId: string, input: UserInput): Promise<void>;
  steer?(sessionId: string, input: UserInput): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  respond(sessionId: string, d: ApprovalDecision): Promise<void>;
  /** 打断时取消该会话自己挂起的审批/提问（SPEC 7.4 AG-*-09 / 2.3 生命周期） */
  cancelPending?(sessionId: string): Promise<void>;
  answer?(sessionId: string, questionId: string, answer: unknown): Promise<void>;
  setModel?(sessionId: string, model: string): Promise<void>;
  /** 切换访问模式（F6）；Codex 在下一次 turn/start 生效，返回值是实际生效的模式 */
  setAccessMode?(sessionId: string, mode: string): Promise<{ accessMode: string } | void>;
  /** 斜杠命令目录（F8）：Claude 来自 init 消息，DSH 来自 commands/list */
  slashCommands?(sessionId: string): Promise<{ name: string; description?: string }[]>;
  dispose(sessionId: string): Promise<void>;
  onEvent(cb: (sessionId: string, e: AdapterEvent) => void): void;
}
