import type { EventData } from '@webdcc/protocol';

type Notice = { itemKey: string; data: EventData['notice'] };
interface Retry {
  turn: number; step: number; retryId: string; retry: number;
  maxRetries?: number; cause?: string; phase: 'waiting' | 'started';
  mode?: 'normal' | 'always';
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function identity(data: Record<string, unknown>): Pick<Retry, 'turn' | 'step' | 'retryId' | 'retry'> | undefined {
  if (!integer(data['turn']) || !integer(data['step']) || !integer(data['retry'], 1)
    || typeof data['retryId'] !== 'string' || data['retryId'] === '') return undefined;
  return { turn: data['turn'], step: data['step'], retryId: data['retryId'], retry: data['retry'] };
}
function key(retry: Retry): string { return `retry-${retry.turn}-${retry.step}-${retry.retryId}`; }
function count(retry: Retry): string { return retry.maxRetries === undefined ? `第 ${retry.retry} 次${retry.mode === 'always' ? '，无固定上限' : ''}` : `${retry.retry}/${retry.maxRetries}`; }
function failure(value: unknown): string | undefined {
  const facts = record(value);
  if (typeof facts?.['message'] !== 'string' || typeof facts['code'] !== 'string') return undefined;
  const label = facts['code'] === 'RATE_LIMIT' ? '模型限流' : facts['code'];
  return `${label}${integer(facts['status'], 100) ? `（HTTP ${facts['status']}）` : ''}：${facts['message']}`;
}
function notice(retry: Retry, text: string, level: 'info' | 'warning' = 'warning'): Notice {
  return { itemKey: key(retry), data: { level, text, nativeType: 'llm/retry' } };
}

/** One durable notice per native request series; later retries replace its state. */
export class DshRetryDisplay {
  private readonly active = new Map<string, Retry>();

  scheduled(data: Record<string, unknown>): Notice | undefined {
    const id = identity(data), cause = failure(data['failure']);
    if (id === undefined || cause === undefined || typeof data['delayMs'] !== 'number' || !Number.isFinite(data['delayMs']) || data['delayMs'] < 0
      || !['normal', 'always'].includes(String(data['mode']))
      || data['mode'] === 'normal' && (!integer(data['maxRetries'], 1) || data['maxRetries'] < id.retry)) return undefined;
    const retry: Retry = { ...id, cause, phase: 'waiting', mode: data['mode'] as 'normal' | 'always', ...(data['mode'] === 'normal' ? { maxRetries: data['maxRetries'] as number } : {}) };
    this.active.set(key(retry), retry);
    return notice(retry, `${cause}；约 ${(data['delayMs'] / 1000).toFixed(1)} 秒后重试（${count(retry)}）`);
  }

  started(data: Record<string, unknown>): Notice | undefined {
    const id = identity(data);
    if (id === undefined) return undefined;
    const prior = this.active.get(key({ ...id, phase: 'started' }));
    const retry: Retry = { ...prior, ...id, phase: 'started' };
    this.active.set(key(retry), retry);
    return notice(retry, `正在重试（${count(retry)}）${retry.cause === undefined ? '' : `；上次失败：${retry.cause}`}`, 'info');
  }

  succeeded(data: Record<string, unknown>): Notice[] {
    return this.settle(data, 'completed', true);
  }

  ended(data: Record<string, unknown>, status: 'completed' | 'interrupted' | 'failed'): Notice[] {
    return this.settle(data, status, false);
  }

  private settle(data: Record<string, unknown>, status: 'completed' | 'interrupted' | 'failed', exactStep: boolean): Notice[] {
    const notices: Notice[] = [];
    for (const [id, retry] of this.active) {
      if (retry.turn !== data['turn'] || exactStep && retry.step !== data['step']) continue;
      const reason = record(data['reason']);
      const cause = failure(reason?.['error']) ?? retry.cause;
      const outcome = status === 'completed' ? '模型重试成功'
        : status === 'interrupted' ? retry.phase === 'waiting' ? '已取消等待重试' : '已停止模型重试'
          : retry.maxRetries !== undefined && retry.retry >= retry.maxRetries && retry.phase === 'started' ? '模型重试失败，已达重试上限' : '模型重试失败';
      notices.push(notice(retry, `${outcome}（${count(retry)}）${cause === undefined ? '' : `；${status === 'completed' ? '上次失败：' : ''}${cause}`}`, status === 'completed' ? 'info' : 'warning'));
      this.active.delete(id);
    }
    return notices;
  }
}
