/**
 * 测试隔离（SPEC-M8 1.4 / 1.6.2）。
 *
 * 所有会启动服务端的入口（单测、fake e2e、真实验收套件、spawnServer）都必须用
 * `isolatedEnv()` 构造环境，把 HOME、CODEX_HOME、CLAUDE_CONFIG_DIR、DSH_HOME
 * 一起指到临时目录里，绝不读写用户真实的 `~/.codex`、`~/.claude`、`~/.dsh`。
 *
 * 服务端在 `WDCC_TEST_HOOKS=1` 时，启动前调用 `assertTestIsolation()`：
 * 这四个目录只要有任何一个落在运行用户的真实家目录里，就拒绝启动。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

export const ISOLATED_KEYS = ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DSH_HOME'] as const;
export type IsolatedKey = (typeof ISOLATED_KEYS)[number];

export interface IsolatedDirs extends Record<IsolatedKey, string> {
  root: string;
  /** 隔离的 `HOME`（小写别名，便于脚本里使用） */
  home: string;
  data: string;
}

/** 运行用户的真实家目录：从系统用户数据库读，不依赖 HOME（SPEC-M8 1.6.2） */
export function realUserHome(): string {
  return userInfo().homedir;
}

export function isInsideDirectory(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/** 在给定根目录下造一套隔离目录（验收套件用：根目录自己管） */
export function isolatedDirsAt(root: string): IsolatedDirs {
  const home = join(root, 'home');
  const dirs: IsolatedDirs = {
    root,
    home,
    HOME: home,
    CODEX_HOME: join(root, 'codex'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    DSH_HOME: join(root, 'dsh'),
    data: join(root, 'data'),
  };
  for (const value of [dirs.home, dirs.CODEX_HOME, dirs.CLAUDE_CONFIG_DIR, dirs.DSH_HOME, dirs.data]) {
    mkdirSync(value, { recursive: true });
  }
  return dirs;
}

/** 造一套隔离目录；prefix 用于在 /tmp 里区分用例 */
export function isolatedDirs(prefix = 'wdcc-isolated'): IsolatedDirs {
  return isolatedDirsAt(mkdtempSync(join(tmpdir(), `${prefix}-`)));
}

/** 在给定环境上套一层隔离（不覆盖已有的隔离目录） */
export function isolatedEnv(base: NodeJS.ProcessEnv = process.env, prefix = 'wdcc-isolated'): { env: NodeJS.ProcessEnv; dirs: IsolatedDirs } {
  const dirs = isolatedDirs(prefix);
  return {
    dirs,
    env: {
      ...base,
      HOME: dirs.home,
      CODEX_HOME: dirs.CODEX_HOME,
      CLAUDE_CONFIG_DIR: dirs.CLAUDE_CONFIG_DIR,
      DSH_HOME: dirs.DSH_HOME,
      WDCC_DATA_DIR: dirs.data,
    },
  };
}

export class RealHomeNotAllowedError extends Error {
  readonly code = 'WDCC_REAL_HOME';
}

/**
 * 启动守卫：测试模式下不允许使用真实家目录（S-04）。
 * 必须在读取任何本机配置之前调用。
 */
export function assertTestIsolation(env: NodeJS.ProcessEnv = process.env): void {
  if (env['WDCC_TEST_HOOKS'] !== '1') return;
  const home = realUserHome();
  for (const key of ISOLATED_KEYS) {
    const value = env[key];
    if (value === undefined || value.trim() === '') {
      throw new RealHomeNotAllowedError(`测试模式下不允许使用真实家目录：${key} 必须指向临时目录`);
    }
    if (isInsideDirectory(value, home)) {
      throw new RealHomeNotAllowedError(`测试模式下不允许使用真实家目录：${key}=${value}`);
    }
  }
}
