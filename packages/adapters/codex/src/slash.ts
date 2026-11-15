import type { SlashCommand, SlashControlResult, ResolvedInputContent } from '@webdcc/protocol';
import { parseSlashInput } from '@webdcc/protocol';
import catalog from './slash-catalog.json' with { type: 'json' };
import { nativeRequest } from './controls.js';
import type { JsonRpcStdio } from './rpc.js';
import { materializeGoal, readGoalObjective } from './goal-files.js';

const routes: Record<string, Pick<SlashCommand, 'route' | 'action'>> = {
  '/model': { route: 'web', action: 'model' }, '/permissions': { route: 'web', action: 'permissions' }, '/skills': { route: 'web', action: 'skills' },
  '/plan': { route: 'web', action: 'plan' }, '/goal': { route: 'native-control', action: 'goal' }, '/rename': { route: 'native-control', action: 'rename' },
  '/compact': { route: 'native-control', action: 'compact' }, '/status': { route: 'native-control', action: 'status' }, '/pwd': { route: 'native-control', action: 'pwd' },
};
export const codexSlashCommands: SlashCommand[] = catalog.commands.map(command => ({ name: command.name, aliases: command.aliases,
  description: command.description, source: `Codex ${catalog.nativeVersion} 原生 CLI`, availableDuringTurn: command.availableDuringTurn,
  supportsAttachments: command.name === '/goal', available: command.name !== '/app' || process.platform === 'darwin' || process.platform === 'win32',
  ...(command.inlineArguments ? { argumentHint: '原生参数' } : {}),
  ...(routes[command.name] ?? { route: 'native-terminal' as const, reason: '此指令由原生交互终端执行' }),
}));
const rejected = (message: string): Error => Object.assign(new Error(message), { statusCode: 400, code: 'native-control-rejected' });
const goalText = (goal: { objective: string; status: string; tokensUsed: number; tokenBudget?: number | null } | null): string => goal === null ? '当前没有原生目标。使用 /goal <目标> 设置。'
  : `目标：${goal.objective}\n状态：${goal.status}\n用量：${goal.tokensUsed}${goal.tokenBudget == null ? '' : ` / ${goal.tokenBudget}`} tokens\n/goal edit · /goal pause · /goal resume · /goal clear`;

/** Mirrors the pinned TUI's Goal control grammar. All other words are the
 * objective, including "edit some text"; no Web instruction text is inserted. */
export async function executeCodexSlash(rpc: JsonRpcStdio, nativeId: string, cwd: string, line: string,
  options: { replaceGoal?: boolean; editGoal?: boolean; contentParts?: ResolvedInputContent; codexHome?: string } = {}): Promise<SlashControlResult> {
  const parsed = parseSlashInput(line);
  if (!parsed) throw rejected('原生指令格式无效');
  const args = parsed.rawArguments.trim();
  const hasAttachments = options.contentParts?.parts.some(part => part.type !== 'text') === true;
  if (hasAttachments && (parsed.name !== '/goal' || !args || options.editGoal !== true && ['edit', 'clear', 'pause', 'resume'].includes(args.toLowerCase()))) throw rejected('请在设置或编辑目标正文时提交附件');
  if (parsed.name === '/pwd' || parsed.name === '/cwd') {
    if (args) throw rejected('/pwd 不接收参数');
    return { text: cwd };
  }
  if (parsed.name === '/status') {
    if (args) throw rejected('/status 不接收参数');
    const result = await nativeRequest(rpc, 'thread/read', { threadId: nativeId, includeTurns: false });
    return { text: JSON.stringify(result.thread, null, 2), result };
  }
  if (parsed.name === '/rename') {
    if (!args) return { form: 'rename' };
    const result = await nativeRequest(rpc, 'thread/name/set', { threadId: nativeId, name: args });
    return { text: '原生会话标题已更新。', result };
  }
  if (parsed.name === '/compact') {
    if (args) throw rejected('/compact 不接收参数');
    const result = await nativeRequest(rpc, 'thread/compact/start', { threadId: nativeId });
    return { text: '已提交原生压缩，等待原生完成通知。', result, confirmed: false };
  }
  if (parsed.name !== '/goal') throw rejected('此指令没有经过验证的原生 API 路由');
  const current = await nativeRequest(rpc, 'thread/goal/get', { threadId: nativeId });
  if (!args) return { text: goalText(current.goal), result: current };
  const control = args.toLowerCase();
  if (control === 'edit' && options.editGoal !== true) {
    if (current.goal === null) throw rejected('当前没有可编辑的原生目标');
    return { form: 'goal-edit', objective: await readGoalObjective(rpc, options.codexHome, current.goal.objective), result: current };
  }
  if (['clear', 'pause', 'resume'].includes(control) && options.editGoal !== true) {
    if (control !== 'clear' && current.goal === null) throw rejected('当前没有可暂停或恢复的原生目标');
    if (control === 'clear') { const result = await nativeRequest(rpc, 'thread/goal/clear', { threadId: nativeId, origin: 'user' }); return { text: '原生目标已清除。', result }; }
    const result = await nativeRequest(rpc, 'thread/goal/set', { threadId: nativeId, origin: 'user', status: control === 'pause' ? 'paused' : 'active' });
    return { text: goalText(result.goal), result };
  }
  if (options.editGoal !== true && current.goal !== null && !['complete', 'budgetLimited'].includes(current.goal.status) && options.replaceGoal !== true) {
    return { form: 'goal-replace', objective: args, text: '已有原生目标。确认替换前将保留原目标。', result: current };
  }
  if (options.editGoal === true && current.goal === null) throw rejected('原生目标已结束或清除，编辑未执行');
  const materialized = await materializeGoal(rpc, options.codexHome, args, options.contentParts);
  if (options.replaceGoal === true || options.editGoal !== true && current.goal !== null) await nativeRequest(rpc, 'thread/goal/clear', { threadId: nativeId, origin: 'user' });
  const previous = current.goal;
  const status = options.editGoal === true && previous !== null && !['complete', 'budgetLimited'].includes(previous.status) ? previous.status : 'active';
  const result = await nativeRequest(rpc, 'thread/goal/set', { threadId: nativeId, origin: 'user', objective: materialized.objective, status,
    ...(options.editGoal === true && previous !== null ? { tokenBudget: previous.tokenBudget } : {}) });
  return { text: goalText(result.goal), result };
}
