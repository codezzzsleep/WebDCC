import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { CreateOpts, RuntimeIdentity, StoredEvent, SessionDto } from '@webdcc/protocol';
import type { Store } from './store.js';
import type { SessionManager } from './manager.js';
import type { Config } from './config.js';
import { NativeTerminalSupervisor } from './native-terminal.js';
import { NativeProcessSupervisor, type NativeProcessBridge } from './native-terminal-process.js';
import { registerNativeTerminalRoutes, type NativeTerminalControlAction } from './native-terminal-routes.js';
import { registerNativeProcessRoutes, type NativeProcessControlAction } from './native-terminal-process-routes.js';
import { nativeSurfaceError, resolveClaudeTerminalBinary, validateNativeTerminalTarget, type NativeTerminalTarget } from './native-surface.js';
import { captureNativeIdentitySnapshot, inspectNativeProcessIdentity, type NativeIdentitySnapshot } from './native-surface-identity.js';
import { payloadHash } from './command-journal.js';

const same = (a: RuntimeIdentity, b: RuntimeIdentity): boolean => a.generation === b.generation && a.ownerId === b.ownerId && a.hostId === b.hostId;
async function executablePath(command: string): Promise<string> {
  if (isAbsolute(command)) return command;
  if (command.includes('/') || command.includes('\\')) throw nativeSurfaceError('原生可执行文件必须使用已安装路径', 503);
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, command);
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  throw nativeSurfaceError('原生可执行文件未安装', 503);
}

/** Fixed server-selected launches; the HTTP caller cannot supply argv/env/cwd. */
export function registerNativeSurfaces(app: FastifyInstance, store: Store, manager: SessionManager, config: Config, onEvent: (event: StoredEvent) => void): void {
  const baselines = new Map<string, NativeIdentitySnapshot>();
  const temporarySettings = new Map<string, string>();
  const terminals = new NativeTerminalSupervisor({
    owners: store.nativeOwners,
    logRoot: join(config.dataDir, 'temporary-native-logs'),
    resolveTarget: async (sessionId, intent) => {
      const source = manager.requireSession(sessionId);
      const configuration = (value: SessionDto): unknown => [value.workspaceId, value.agent, value.providerId, value.model, value.reasoningEffort, value.accessMode];
      const sourceRevision = payloadHash(configuration(source));
      if (source.agent !== 'codex' && source.agent !== 'claude-code') throw nativeSurfaceError('此 Agent 使用原生 Web 入口', 400);
      if (intent === 'same-session') throw nativeSurfaceError('外部 writer 释放与完整历史/设置对账尚未验证，同会话接管受阻');
      const workspace = store.getWorkspace(source.workspaceId);
      const adapter = manager.adapter(source.agent);
      if (!workspace || !adapter) throw nativeSurfaceError('原生工作区或 Adapter 不可用', 404);
      const selectedEnv = adapter.nativeTerminalEnvironment?.() ?? process.env;
      const profileVariable = source.agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
      const profilePath = resolve(selectedEnv[profileVariable] ?? join(selectedEnv['HOME'] ?? homedir(), source.agent === 'codex' ? '.codex' : '.claude'));
      await mkdir(profilePath, { recursive: true, mode: 0o700 });
      const opts: CreateOpts = { sessionId, cwd: workspace.path, providerId: source.providerId ?? null,
        model: source.model, reasoningEffort: source.reasoningEffort, accessMode: source.accessMode };
      // Provider credentials stay in the server-selected launch environment.
      const provider = source.providerId ? manager.optionsProvider(source.providerId) : undefined;
      if (provider !== undefined) opts.provider = provider;
      const spec = adapter.buildLaunchSpec(opts);
      const env: Record<string, string> = {};
      for (const key of ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']) {
        if (selectedEnv[key] !== undefined) env[key] = selectedEnv[key]!;
      }
      Object.assign(env, spec.env, { HOME: env['HOME'] ?? homedir(), [profileVariable]: profilePath });
      const executable = source.agent === 'codex' ? await executablePath(spec.command ?? 'codex') : resolveClaudeTerminalBinary();
      let settingsDirectory: string | undefined;
      const launchOptions = source.agent === 'codex' ? (spec.args ?? []).slice(1) : source.model ? ['--model', source.model] : [];
      if (source.agent === 'claude-code') {
        if (source.accessMode && source.accessMode !== 'inherit') {
          if (!['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan', 'manual'].includes(source.accessMode)) throw nativeSurfaceError('此 SDK 权限模式尚未验证可用于原生 CLI；请使用结构化界面');
          if (source.accessMode === 'bypassPermissions' && process.getuid?.() === 0) throw nativeSurfaceError('原生 Claude CLI 不允许 root 使用 bypassPermissions', 400);
          launchOptions.push('--permission-mode', source.accessMode);
        }
        if (source.reasoningEffort) {
          if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(source.reasoningEffort)) throw nativeSurfaceError('原生 CLI 不支持当前思考强度', 400);
          launchOptions.push('--effort', source.reasoningEffort);
        }
        const settings = spec.sdkOptions?.['settings'];
        if (settings !== undefined) {
          const root = join(config.dataDir, 'temporary-native-settings'); await mkdir(root, { recursive: true, mode: 0o700 });
          settingsDirectory = await mkdtemp(join(root, 'launch-'));
          try {
            const file = join(settingsDirectory, 'settings.json');
            await writeFile(file, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
            launchOptions.push('--settings', file);
          } catch (error) { await rm(settingsDirectory, { recursive: true, force: true }); throw error; }
        }
      }
      const authorized: NativeTerminalTarget = { sourceSessionId: sessionId, ownerSessionId: `pending:${sessionId}`, agent: source.agent,
        executable, nativeVersion: source.agent === 'codex' ? '0.167.0' : '2.1.322', cwd: workspace.path, profilePath, env,
        launchOptions };
      let baseline: NativeIdentitySnapshot;
      try { await validateNativeTerminalTarget(authorized, intent); baseline = await captureNativeIdentitySnapshot(authorized); }
      catch (error) { if (settingsDirectory) await rm(settingsDirectory, { recursive: true, force: true }); throw error; }
      let child: SessionDto;
      try {
        if (payloadHash(configuration(manager.requireSession(sessionId))) !== sourceRevision) throw nativeSurfaceError('原生启动配置已变化，请核对后重新打开');
        child = store.createSession({ workspaceId: source.workspaceId, agent: source.agent, providerId: source.providerId,
          model: source.model, reasoningEffort: source.reasoningEffort, accessMode: source.accessMode, title: '新原生 CLI 会话' });
      } catch (error) { if (settingsDirectory) await rm(settingsDirectory, { recursive: true, force: true }); throw error; }
      manager.updateSessionAndFeed(child.id, { status: 'idle' }, { created: true, agent: child.agent, workspaceId: child.workspaceId, title: child.title, createdAt: child.createdAt, status: 'idle' });
      const target: NativeTerminalTarget = { ...authorized, ownerSessionId: child.id };
      baselines.set(child.id, baseline);
      if (settingsDirectory) temporarySettings.set(child.id, settingsDirectory);
      return target;
    },
    verifyNativeIdentity: async (target, process) => {
      const baseline = baselines.get(target.ownerSessionId);
      if (!baseline) return undefined;
      const result = await inspectNativeProcessIdentity(target, process, baseline);
      return result.status === 'verified' ? { nativeId: result.nativeId!, evidence: result.evidence! } : undefined;
    },
    onNativeIdentity: (target, nativeId) => { manager.updateSessionAndFeed(target.ownerSessionId, { nativeId }, {}); },
    onIdentityInspection: (target, inspection) => {
      // Persist bounded identity changes only; launch environment and terminal
      // input/output are intentionally absent from this metadata event.
      const event = store.appendEvent({ sessionId: target.ownerSessionId, turnId: null,
        itemKey: `native-cli-identity-${inspection.generation}-${inspection.observedAt}`,
        kind: 'internal', data: { nativeType: 'native-cli-identity' }, native: inspection });
      onEvent(event);
    },
    onReleased: async (target, verified) => {
      baselines.delete(target.ownerSessionId);
      const settings = temporarySettings.get(target.ownerSessionId); temporarySettings.delete(target.ownerSessionId);
      if (settings) await rm(settings, { recursive: true, force: true });
      manager.updateSessionAndFeed(target.ownerSessionId, { status: verified ? 'idle' : 'error' }, { status: verified ? 'idle' : 'error' });
    },
  });
  const runtime = (sessionId: string) => {
    manager.requireSession(sessionId);
    const value = manager.getRuntime(sessionId);
    if (!value || value.disposing || !store.nativeOwners.current(sessionId, value.identity)) throw nativeSurfaceError('原生连接未激活或 owner 已更换');
    if (value.adapter.nativeProcessStart === undefined) throw nativeSurfaceError('此 Agent 未验证原生命令控制', 501);
    return value;
  };
  const bridge: NativeProcessBridge = {
    context: sessionId => {
      const value = runtime(sessionId);
      const policy = value.adapter.id === 'codex' ? store.getSession(sessionId)?.permissions?.policy as { sandbox?: { type?: string; networkAccess?: boolean; writableRoots?: string[] } } | undefined : undefined;
      const names: Record<string, string> = { readOnly: '只读', workspaceWrite: '工作区可写', dangerFullAccess: '完全访问', externalSandbox: '外部沙箱' };
      const sandbox = policy?.sandbox;
      return { identity: value.identity, nativeId: value.nativeId, agent: value.adapter.id as 'codex', cwd: value.workspacePath,
        permissions: { source: 'native-command-config', matchesSession: policy?.sandbox != null,
          description: `沙箱：${names[sandbox?.type ?? ''] ?? '未确认'}；网络：${sandbox?.networkAccess === true ? '允许' : sandbox?.networkAccess === false ? '受限' : '沿用原生规则'}；工作目录：${value.workspacePath}${sandbox?.writableRoots?.length ? `；可写目录：${sandbox.writableRoots.join('、')}` : ''}。` } };
    },
    assert: (sessionId, identity) => { if (!same(runtime(sessionId).identity, identity)) throw nativeSurfaceError('旧原生连接不能写入'); },
    start: async (sessionId, processId, params, output) => {
      const value = runtime(sessionId); const release = manager.holdNativeActivity(sessionId);
      try { return await value.adapter.nativeProcessStart!(sessionId, { processId, ...params }, output); }
      finally { release(); }
    },
    write: async (sessionId, params) => { await runtime(sessionId).adapter.nativeProcessWrite!(sessionId, params); },
    resize: async (sessionId, params) => { await runtime(sessionId).adapter.nativeProcessResize!(sessionId, params); },
    terminate: async (sessionId, params) => { await runtime(sessionId).adapter.nativeProcessTerminate!(sessionId, params); },
  };
  const processes = new NativeProcessSupervisor(bridge, {
    logRoot: join(config.dataDir, 'temporary-native-logs'),
    onState: view => {
      const value = manager.getRuntime(view.sessionId);
      if (view.confirmed && value && view.generation === value.identity.generation && view.nativeId === value.nativeId
        && (view.state === 'running' || view.state === 'exited')) store.nativeActions.confirmReference(view.sessionId, value.identity, view.nativeId, 'native-process-start', view.id);
    },
  });
  const executeControl = async <T>(action: NativeTerminalControlAction | NativeProcessControlAction, run: () => Promise<T>): Promise<T> => {
    manager.requireSession(action.sessionId);
    const { commandId, sessionId, kind, ...payload } = action;
    const response = await store.nativeActions.execute(sessionId, { commandId, action: { type: kind.replaceAll('.', '-'), ...payload } }, async () => {
      if (kind === 'native-process.start') { const value = runtime(sessionId); store.nativeActions.bind(commandId, value.identity, value.nativeId); }
      return run();
    });
    if (kind === 'native-process.start' && response.receipt.reference) {
      const view = processes.get(response.receipt.reference.id); const value = manager.getRuntime(sessionId);
      if (view.confirmed && value && view.nativeId === value.nativeId && view.generation === value.identity.generation) store.nativeActions.confirmReference(sessionId, value.identity, value.nativeId, 'native-process-start', view.id);
      return view as T;
    }
    if (response.result !== undefined) return response.result as T;
    if (response.receipt.state !== 'completed') throw nativeSurfaceError('原生命令仍在执行或结果未确认，禁止重发');
    if (kind.endsWith('.close')) return { closed: true } as T;
    const reference = response.receipt.reference;
    if (!reference) throw nativeSurfaceError('旧命令没有可恢复的资源身份，请核对原生状态', 410);
    try { return (kind.startsWith('native-terminal.') ? terminals.get(reference.id) : processes.get(reference.id)) as T; }
    catch { throw nativeSurfaceError('此原生资源已不在当前服务中，不能重复启动', 410); }
  };
  registerNativeTerminalRoutes(app, { supervisor: terminals, config, executeControl });
  registerNativeProcessRoutes(app, { supervisor: processes, config, executeControl });
}
