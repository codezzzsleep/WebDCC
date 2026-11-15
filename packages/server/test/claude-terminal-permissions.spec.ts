import { expect, it } from 'vitest';
import { ClaudeAdapter } from '../../adapters/claude/src/adapter.js';
import { claudeTerminalPermissionMode } from '../src/claude-terminal-permissions.js';
import { nativeTerminalArgv, type NativeTerminalTarget } from '../src/native-surface.js';

const argv = (mode: string | undefined, uid = 1000) => {
  const nativeMode = claudeTerminalPermissionMode(mode, uid);
  const target: NativeTerminalTarget = { sourceSessionId: 'source', ownerSessionId: 'new-native', agent: 'claude-code', nativeVersion: '2.1.322', executable: '/installed/claude', cwd: '/workspace', profilePath: '/profile', env: {}, launchOptions: nativeMode === undefined ? [] : ['--permission-mode', nativeMode] };
  return nativeTerminalArgv(target, 'new-native');
};

it.each(new ClaudeAdapter().accessModes())('launches the public SDK permission $id with its fixed native CLI equivalent', ({ id }) => {
  expect(argv(id)).toEqual(['--permission-mode', id === 'default' ? 'manual' : id]);
});

it.each([undefined, '', 'inherit'])('preserves native profile defaults when mode is %s', mode => {
  expect(argv(mode)).toEqual([]);
});

it('keeps the known native manual spelling and allows SDK default for root without bypassing permissions', () => {
  expect(argv('manual')).toEqual(['--permission-mode', 'manual']);
  expect(argv('default', 0)).toEqual(['--permission-mode', 'manual']);
});

it.each(['unknown', 'read-only', 'allowAll', 'default --bypassPermissions', 'manual\n--model=other'])('rejects unreviewed permission value %s before launch', mode => {
  expect(() => argv(mode)).toThrow('权限模式尚未验证');
});

it('retains the native root bypass restriction and the allowed non-root setting', () => {
  expect(() => argv('bypassPermissions', 0)).toThrow('不允许 root');
  try { argv('bypassPermissions', 0); } catch (error) { expect(error).toMatchObject({ statusCode: 400 }); }
  expect(argv('bypassPermissions', 1000)).toEqual(['--permission-mode', 'bypassPermissions']);
});
