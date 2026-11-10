/**
 * 脚本化假模型的回放计划（SPEC 第 13 节）。
 *
 * `plan.json` 是一个数组：第 N 项（0 基）是"收到第 N 个工具结果之后"要返回的内容块。
 * 每项可以是 text、thinking、tool 的组合；tool 只写语义 kind，具体工具名按请求里
 * 实际提供的 `tools` 名称匹配（这样同一份 plan 可以喂给 DSH、Claude Code、Codex）。
 */

export type ToolKind =
  | 'command'
  | 'read'
  | 'write'
  | 'edit'
  | 'glob'
  | 'grep'
  | 'todo'
  | 'ask'
  | 'patch'
  | 'other';

export interface PlanToolCall {
  kind: ToolKind;
  /** 直接指定原生工具名；缺省时按 kind 在同请求的 tools 里匹配 */
  name?: string;
  input?: Record<string, unknown>;
  /** 覆盖默认的 tool_use / function_call id，便于断言 */
  callId?: string;
  /**
   * 备选方案：同一个语义动作用不同 Agent 的不同原生工具表达。
   * 例如"写文件"在 DSH/Claude 是 write，在 Codex 是 apply_patch。
   * 按顺序选第一个在当前请求的工具表里存在的。
   */
  alternatives?: PlanToolCall[];
  /**
   * 按原生工具名覆盖入参：不同 Agent 的同义工具参数名不同
   * （DSH/Claude 的 bash 收 command，Codex 的 exec_command 收 cmd）。
   */
  inputByName?: Record<string, Record<string, unknown>>;
}

export interface PlanStep {
  thinking?: string;
  text?: string;
  tool?: PlanToolCall;
  /** 缺省时：有 tool 用 tool_use，否则 end_turn */
  stopReason?: string;
  /** 每个增量之间的人为延迟，用来模拟慢速流（毫秒） */
  chunkDelayMs?: number;
}

export type Plan = PlanStep[];

/** 工具名按语义归类时的候选原生名（小写比较） */
const TOOL_ALIASES: Record<Exclude<ToolKind, 'other'>, string[]> = {
  command: ['bash', 'shell', 'exec_command', 'run_command', 'local_shell', 'terminal', 'container.exec'],
  read: ['read', 'read_file', 'fs_read', 'view_file', 'readfile'],
  write: ['write', 'write_file', 'fs_write', 'create_file', 'writefile'],
  // 注意：不含 apply_patch —— 它的入参是补丁文本，不是 file_path/old_string/new_string，
  // 需要时用 alternatives 里的 patch 专门表达。
  edit: ['edit', 'str_replace', 'edit_file', 'replace_in_file'],
  glob: ['glob', 'list_files', 'find_files'],
  grep: ['grep', 'search', 'search_files'],
  todo: ['todo_write', 'update_plan', 'write_todos', 'todowrite'],
  ask: ['ask_user_question', 'ask_human', 'request_user_input'],
  patch: ['apply_patch', 'edit_file', 'str_replace_editor'],
};

export interface ToolDescriptor {
  name: string;
  [key: string]: unknown;
}

/**
 * 在请求提供的工具里为一个 kind 挑出原生工具名。
 *
 * 匹配顺序（避免 write 命中 write_stdin 这类误判）：
 *   1) 全名相等
 *   2) 最后一段相等（exec_command → command）
 *   3) 以 `_<alias>` 结尾（mcp__fs__read_file → read_file）
 * 找不到时返回 undefined，调用方退化为纯文本回复。
 */
export function pickToolName(kind: ToolKind, tools: readonly ToolDescriptor[] | undefined): string | undefined {
  if (!tools || tools.length === 0) return undefined;
  if (kind === 'other') return undefined;
  const aliases = TOOL_ALIASES[kind];
  // 有的 Agent 会同时下发没有 name 的内置工具（如 {"type":"web_search"}），跳过它们
  const named = tools
    .filter((t): t is ToolDescriptor & { name: string } => typeof t.name === 'string')
    .map((t) => ({ original: t.name, lower: t.name.toLowerCase() }));

  const lastSegment = (name: string): string => name.split(/[./]/).pop() ?? name;

  for (const { original, lower } of named) {
    if (aliases.includes(lower)) return original;
  }
  for (const { original, lower } of named) {
    const tail = lastSegment(lower);
    if (aliases.includes(tail)) return original;
  }
  for (const { original, lower } of named) {
    if (aliases.some((alias) => lower.endsWith(`_${alias}`) || lower.endsWith(`.${alias}`))) return original;
  }
  return undefined;
}

/** 计划项耗尽后的兜底回复，避免无限工具调用环 */export const EXHAUSTED_STEP: PlanStep = {
  text: '（脚本化假模型：计划已回放完毕）',
  stopReason: 'end_turn',
};

/** 取第 index 步；越界返回兜底项 */
export function stepAt(plan: Plan, index: number): PlanStep {
  return plan[index] ?? EXHAUSTED_STEP;
}

export function isPlan(value: unknown): value is Plan {
  return (
    Array.isArray(value) &&
    value.every(
      (s) =>
        typeof s === 'object' &&
        s !== null &&
        (!('tool' in s) || typeof (s as PlanStep).tool === 'object') &&
        (!('text' in s) || typeof (s as PlanStep).text === 'string'),
    )
  );
}

export interface ResolvedTool {
  name: string;
  input: Record<string, unknown>;
  callId?: string;
  /** 命中的语义 kind，便于日志 */
  kind: ToolKind;
}

/**
 * 把一个语义动作解析成具体的原生工具调用：先试自身 kind，再依次试 alternatives。
 * 都匹配不上返回 undefined（调用方退化为纯文本回复）。
 */
export function resolveTool(
  call: PlanToolCall | undefined,
  tools: readonly ToolDescriptor[] | undefined,
): ResolvedTool | undefined {
  if (!call) return undefined;
  const candidates: PlanToolCall[] = [call, ...(call.alternatives ?? [])];
  for (const candidate of candidates) {
    const name = candidate.name ?? pickToolName(candidate.kind, tools);
    if (name === undefined) continue;
    return {
      name,
      input: candidate.inputByName?.[name] ?? candidate.input ?? {},
      ...(candidate.callId === undefined ? {} : { callId: candidate.callId }),
      kind: candidate.kind,
    };
  }
  return undefined;
}
