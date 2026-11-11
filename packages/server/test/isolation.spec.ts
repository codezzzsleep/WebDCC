/** SPEC-M8 1.4 / 1.6.2：统一隔离与启动守卫 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ISOLATED_KEYS, assertTestIsolation, isolatedDirs, realUserHome } from '../src/test-isolation.js';

describe('测试隔离守卫（S-04）', () => {
  it('四个目录都在临时目录时允许启动', () => {
    const dirs = isolatedDirs('wdcc-isolation-test');
    expect(() =>
      assertTestIsolation({
        WDCC_TEST_HOOKS: '1',
        HOME: dirs.HOME,
        CODEX_HOME: dirs.CODEX_HOME,
        CLAUDE_CONFIG_DIR: dirs.CLAUDE_CONFIG_DIR,
        DSH_HOME: dirs.DSH_HOME,
      }),
    ).not.toThrow();
  });

  it.each(ISOLATED_KEYS)('%s 指向真实家目录时拒绝启动', (key) => {
    const dirs = isolatedDirs('wdcc-isolation-test');
    const env: NodeJS.ProcessEnv = {
      WDCC_TEST_HOOKS: '1',
      HOME: dirs.HOME,
      CODEX_HOME: dirs.CODEX_HOME,
      CLAUDE_CONFIG_DIR: dirs.CLAUDE_CONFIG_DIR,
      DSH_HOME: dirs.DSH_HOME,
    };
    env[key] = join(realUserHome(), '.something');
    expect(() => assertTestIsolation(env)).toThrow(/测试模式下不允许使用真实家目录/);
  });

  it('完全没有设置时拒绝启动', () => {
    expect(() => assertTestIsolation({ WDCC_TEST_HOOKS: '1' })).toThrow(/测试模式下不允许使用真实家目录/);
  });

  it('不是测试模式时不做限制', () => {
    expect(() => assertTestIsolation({})).not.toThrow();
  });
});

describe('所有测试入口都调用同一个 isolatedEnv（代码检查）', () => {
  const root = join(__dirname, '../../..');
  const entrypoints = [
    'scripts/e2e-server.ts',
    'e2e-real/fixtures.ts',
    'e2e-real/globalSetup.ts',
    'packages/server/test/helpers.ts',
  ];

  it.each(entrypoints)('%s 使用 isolatedEnv / isolatedDirs', (file) => {
    const text = readFileSync(join(root, file), 'utf8');
    expect(/isolatedEnv|isolatedDirs/.test(text), file).toBe(true);
  });
});
