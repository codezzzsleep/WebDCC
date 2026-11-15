import type { AgentId } from './adapter.js';
import type { TraceFrame } from './trace.js';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function scenarioNativePredicates(scenario: string): string[] {
  if (scenario === 'S04') return ['approval.request', 'approval.accepted'];
  if (scenario === 'S05') return ['approval.request', 'approval.declined'];
  if (scenario === 'S08') return ['question.request', 'question.answered'];
  return [];
}

/** Read native wire frames independently of adapter projection output. */
export function nativePredicates(agent: AgentId, frames: TraceFrame[]): Record<string, boolean> {
  const observed: Record<string, boolean> = {};
  const requests = new Map<string | number, 'approval' | 'question'>();
  for (const frame of frames) {
    const raw = record(frame.frame);
    if (agent === 'codex' && frame.ch === 'rpc') {
      const id = raw['id'];
      if (typeof id !== 'string' && typeof id !== 'number') continue;
      const method = raw['method'];
      if (frame.dir === 'in' && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval'].includes(String(method))) {
        observed['approval.request'] = true; requests.set(id, 'approval');
      } else if (frame.dir === 'in' && method === 'item/tool/requestUserInput') {
        observed['question.request'] = true; requests.set(id, 'question');
      } else if (frame.dir === 'out' && requests.has(id)) {
        const result = record(raw['result']);
        const decision = result['decision'];
        if (requests.get(id) === 'approval') {
          if (['accept', 'acceptForSession', 'approved', 'approved_for_session'].includes(String(decision))) observed['approval.accepted'] = true;
          if (['decline', 'denied', 'cancel'].includes(String(decision))) observed['approval.declined'] = true;
        } else if (Object.keys(record(result['answers'])).length > 0) observed['question.answered'] = true;
      }
    } else if (agent === 'claude-code') {
      if (frame.ch === 'canUseTool' && frame.dir === 'in') {
        const question = raw['toolName'] === 'AskUserQuestion';
        observed[question ? 'question.request' : 'approval.request'] = true;
        if (typeof raw['toolUseID'] === 'string') requests.set(raw['toolUseID'], question ? 'question' : 'approval');
      } else if (frame.ch === 'canUseTool-result' && frame.dir === 'out') {
        const id = raw['toolUseID'];
        if (typeof id !== 'string' || !requests.has(id)) continue;
        const result = record(raw['result']);
        if (requests.get(id) === 'question' && Object.keys(record(record(result['updatedInput'])['answers'])).length > 0) observed['question.answered'] = true;
        else if (result['behavior'] === 'allow') observed['approval.accepted'] = true;
        else if (result['behavior'] === 'deny') observed['approval.declined'] = true;
      }
    } else if (agent === 'dsh') {
      const value = record(raw['value']);
      if (frame.dir === 'in' && value['type'] === 'waterfall') {
        const event = value['event'];
        const id = value['eventId'];
        if (typeof id === 'string' && (event === 'approval/request' || event === 'user-questions/request')) {
          const question = event === 'user-questions/request';
          requests.set(id, question ? 'question' : 'approval'); observed[question ? 'question.request' : 'approval.request'] = true;
        }
      } else if (frame.dir === 'out' && frame.ch === 'rpc:$events/result') {
        const args = record(raw['args'] ?? raw);
        const id = args['eventId'];
        if (typeof id !== 'string' || !requests.has(id)) continue;
        const result = record(args['outcome'])['value'];
        if (requests.get(id) === 'question' && Array.isArray(record(result)['answers']) && (record(result)['answers'] as unknown[]).length > 0) observed['question.answered'] = true;
        else if (typeof result === 'string' && result.startsWith('allowed')) observed['approval.accepted'] = true;
        else if (['rejected', 'cancelled'].includes(String(result))) observed['approval.declined'] = true;
      }
    }
  }
  return observed;
}
