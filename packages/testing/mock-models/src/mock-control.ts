/**
 * 假模型的控制面（SPEC-M8 6.3）：请求记录、重置、切换计划、模板变量、工具不匹配报错。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan, PlanVariant } from './plan.js';

export interface RecordedRequest {
  at: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  /** 是否因为工具不匹配被拒（HTTP 500） */
  failed?: boolean;
  /** 辅助请求（没有 tools，例如生成标题），不推进计划 */
  helper?: boolean;
}

export interface PlanStepShape {
  tool?: { kind: string; name?: string; input?: Record<string, unknown>; alternatives?: { kind: string; name?: string; input?: Record<string, unknown> }[] };
  text?: string;
  thinking?: string;
  stopReason?: string;
  chunkDelayMs?: number;
}

export class MockControl {
  readonly requests: RecordedRequest[] = [];
  private plan: unknown[] = [];
  private planName = '';
  private readonly plansDir: string;

  constructor(initial: unknown[], plansDir: string) {
    this.plan = initial;
    this.plansDir = plansDir;
  }

  get currentPlan(): unknown[] {
    return this.plan;
  }

  reset(): void {
    this.requests.length = 0;
  }

  setPlan(name: string): void {
    const file = join(this.plansDir, `${name}.json`);
    this.plan = JSON.parse(readFileSync(file, 'utf8')) as unknown[];
    this.planName = name;
  }

  /**
   * 取该 Agent 变体的计划：优先 `<name>.<variant>.json`，没有再退回 `<name>.json`。
   * 每个 Agent 用自己的变体，缺少必需的工具时由调用方返回 500（SPEC-M8 6.3）。
   */
  planForVariant(variant: PlanVariant): Plan {
    if (this.planName !== '') {
      const variantFile = join(this.plansDir, `${this.planName}.${variant}.json`);
      if (existsSync(variantFile)) return JSON.parse(readFileSync(variantFile, 'utf8')) as Plan;
    }
    return this.plan as Plan;
  }

  record(entry: RecordedRequest): void {
    this.requests.push(entry);
  }

  /** 把 {{userMessageCount}} / {{imageCount}} / {{model}} 替换成请求里的实际值 */
  render(text: string, vars: { userMessageCount: number; imageCount: number; model: string }): string {
    return text
      .replaceAll('{{userMessageCount}}', String(vars.userMessageCount))
      .replaceAll('{{imageCount}}', String(vars.imageCount))
      .replaceAll('{{model}}', vars.model);
  }
}

/** 从 Anthropic Messages 请求体里数用户消息与图片块 */
export function countAnthropic(body: Record<string, unknown>): { userMessageCount: number; imageCount: number; model: string } {
  const messages = Array.isArray(body['messages']) ? (body['messages'] as Record<string, unknown>[]) : [];
  let userMessageCount = 0;
  let imageCount = 0;
  for (const message of messages) {
    if (message['role'] !== 'user') continue;
    const content = message['content'];
    if (!Array.isArray(content)) {
      userMessageCount += 1;
      continue;
    }
    // 工具结果是 role=user 的 tool_result 块，不算"用户消息"（AG-*-11）
    const hasToolResult = content.some((block) => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_result');
    const hasText = content.some((block) => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text');
    if (hasText && !hasToolResult) userMessageCount += 1;
    for (const block of content) {
      if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'image') imageCount += 1;
    }
  }
  return {
    userMessageCount,
    imageCount,
    model: typeof body['model'] === 'string' ? body['model'] : '',
  };
}

/** 从 OpenAI Responses 请求体里数用户消息与图片块 */
export function countResponses(body: Record<string, unknown>): { userMessageCount: number; imageCount: number; model: string } {
  const input = Array.isArray(body['input']) ? (body['input'] as Record<string, unknown>[]) : [];
  let userMessageCount = 0;
  let imageCount = 0;
  for (const item of input) {
    if (item['type'] !== 'message' || item['role'] !== 'user') continue;
    userMessageCount += 1;
    const content = item['content'];
    if (Array.isArray(content)) {
      for (const part of content) {
        const type = typeof part === 'object' && part !== null ? (part as { type?: string }).type : undefined;
        if (type === 'input_image' || type === 'image') imageCount += 1;
      }
    }
  }
  return {
    userMessageCount,
    imageCount,
    model: typeof body['model'] === 'string' ? body['model'] : '',
  };
}

/** 辅助请求的固定回复（SPEC-M8 6.3：完全没有 tools 的请求） */
export const HELPER_REPLY = '（辅助请求：不推进计划）';
