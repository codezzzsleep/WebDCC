import type { CanUseTool, PermissionUpdate, PermissionUpdateDestination } from '@anthropic-ai/claude-agent-sdk';
import type { ApprovalOption } from '@webdcc/protocol';

export type ClaudePermissionOptions = { signal: AbortSignal; toolUseID?: string } & Pick<Parameters<CanUseTool>[2], 'suggestions' | 'suppressAlwaysAllowRule' | 'defaultToNo'>;
const destinations: Record<PermissionUpdateDestination, string> = { session: '本会话', cliArg: '启动参数', userSettings: '用户设置', projectSettings: '项目设置', localSettings: '项目本地设置' };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, names: string[]): boolean { return Object.keys(value).every(key => names.includes(key)); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string'); }
function update(value: unknown): value is PermissionUpdate {
  if (!object(value) || typeof value['destination'] !== 'string' || !Object.hasOwn(destinations, value['destination'])) return false;
  switch (value['type']) {
    case 'addRules': case 'replaceRules': case 'removeRules':
      return keys(value, ['type', 'destination', 'behavior', 'rules']) && typeof value['behavior'] === 'string' && ['allow', 'deny', 'ask'].includes(value['behavior'])
        && Array.isArray(value['rules']) && value['rules'].every(rule => object(rule) && keys(rule, ['toolName', 'ruleContent'])
          && typeof rule['toolName'] === 'string' && (rule['ruleContent'] === undefined || typeof rule['ruleContent'] === 'string'));
    case 'setMode':
      return keys(value, ['type', 'destination', 'mode']) && typeof value['mode'] === 'string' && ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(value['mode']);
    case 'addDirectories': case 'removeDirectories':
      return keys(value, ['type', 'destination', 'directories']) && strings(value['directories']);
    default: return false;
  }
}

/** Native updates are one proposal: the SDK requires the full set. Unknown
 * updates disable the proposal instead of dropping fields or widening it. */
export function permissionSuggestions(value: unknown): PermissionUpdate[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every(update) ? structuredClone(value) : undefined;
}
export function permissionProposal(options: Pick<ClaudePermissionOptions, 'suggestions' | 'suppressAlwaysAllowRule' | 'defaultToNo'>): { options: ApprovalOption[]; suggestions?: PermissionUpdate[] } {
  const allow = { id: 'allow', label: '允许一次' }; const deny = { id: 'deny', label: '拒绝' };
  const choices = options.defaultToNo === true ? [deny, allow] : [allow, deny];
  const suggestions = options.suppressAlwaysAllowRule === true ? undefined : permissionSuggestions(options.suggestions);
  if (suggestions === undefined) return { options: choices };
  const scopes = [...new Set(suggestions.map(suggestion => destinations[suggestion.destination]))].join('、');
  choices.push({ id: 'allow-native-suggestions', label: `允许并应用原生建议（${scopes}）` });
  return { options: choices, suggestions };
}
