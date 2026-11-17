import type { StoredEvent } from './events.js';

/** Restorable startup overrides, not a claim about generated model behavior. */
export interface ClaudeQueryOptions {
  thinking?: { type: 'adaptive'; display?: 'summarized' | 'omitted' }
    | { type: 'enabled'; budgetTokens?: number; display?: 'summarized' | 'omitted' }
    | { type: 'disabled' };
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  enableFileCheckpointing?: boolean;
}
export interface ClaudeQueryConfiguration {
  formatVersion: 1;
  queryId: string;
  nativeSessionId: string | null;
  sdkVersion: string;
  cliVersion: string;
  scopeFingerprint: string;
  requestedModel: string | null;
  options: ClaudeQueryOptions;
  optionsFingerprint: string;
  nativeAcceptedAt: string;
  modelEffect: 'not-observed';
  restoredFromQueryId?: string;
}
export type ClaudeConfigurationRecovery = { state: 'none' }
  | { state: 'accepted'; configuration: ClaudeQueryConfiguration }
  | { state: 'unavailable'; reason: string };

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): value is string => typeof value === 'string' && value !== '';
const digest = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export function isClaudeQueryConfiguration(value: unknown): value is ClaudeQueryConfiguration {
  const v = object(value); const options = object(v['options']);
  if (v['formatVersion'] !== 1 || !text(v['queryId']) || v['nativeSessionId'] !== null && !text(v['nativeSessionId'])
    || !text(v['sdkVersion']) || !text(v['cliVersion']) || !digest(v['scopeFingerprint']) || !digest(v['optionsFingerprint'])
    || v['requestedModel'] !== null && !text(v['requestedModel']) || v['modelEffect'] !== 'not-observed'
    || !text(v['nativeAcceptedAt']) || !Number.isFinite(Date.parse(v['nativeAcceptedAt']))
    || v['restoredFromQueryId'] !== undefined && !text(v['restoredFromQueryId'])
    || v['options'] === null || typeof v['options'] !== 'object' || Array.isArray(v['options'])
    || Object.keys(options).some(key => !['thinking', 'outputFormat', 'enableFileCheckpointing'].includes(key))) return false;
  if (options['enableFileCheckpointing'] !== undefined && typeof options['enableFileCheckpointing'] !== 'boolean') return false;
  if (options['outputFormat'] !== undefined) {
    const output = object(options['outputFormat']);
    if (output['type'] !== 'json_schema' || output['schema'] === null || typeof output['schema'] !== 'object' || Array.isArray(output['schema'])
      || Object.keys(output).some(key => !['type', 'schema'].includes(key))) return false;
  }
  if (options['thinking'] !== undefined) {
    const thinking = object(options['thinking']); const type = thinking['type'];
    const keys = type === 'disabled' ? ['type'] : type === 'adaptive' ? ['type', 'display'] : ['type', 'display', 'budgetTokens'];
    if (!['adaptive', 'enabled', 'disabled'].includes(String(type)) || Object.keys(thinking).some(key => !keys.includes(key))
      || thinking['display'] !== undefined && !['summarized', 'omitted'].includes(String(thinking['display']))
      || thinking['budgetTokens'] !== undefined && (!Number.isSafeInteger(thinking['budgetTokens']) || Number(thinking['budgetTokens']) < 1024)) return false;
  }
  return true;
}

/** A closed or superseded query cannot publish a later configuration. Empty
 * options are a complete accepted snapshot and deliberately clear overrides. */
export function currentClaudeConfiguration(events: Pick<StoredEvent, 'kind' | 'data'>[], nativeSessionId: string): ClaudeConfigurationRecovery {
  let queryId: string | undefined; let live = false;
  const seen = new Set<string>(); let current: ClaudeConfigurationRecovery = { state: 'none' };
  for (const event of events) {
    if (event.kind !== 'internal') continue;
    const data = object(event.data); const signal = object(data['claudeTaskRuntime']);
    if (signal['state'] === 'started' && text(signal['id']) && !seen.has(signal['id'])) {
      queryId = signal['id']; seen.add(queryId); live = true;
    } else if (signal['state'] === 'unavailable' && signal['id'] === queryId) live = false;
    if (data['nativeType'] !== 'claude/query-configuration') continue;
    const value = object(data['claudeConfiguration']);
    if (!live || value['queryId'] !== queryId || value['nativeSessionId'] !== nativeSessionId) continue;
    current = isClaudeQueryConfiguration(value) ? { state: 'accepted', configuration: value }
      : { state: 'unavailable', reason: 'Claude 已接受配置的记录无效，请核对原生设置' };
  }
  return current;
}
