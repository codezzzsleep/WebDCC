/** 结束本套件自己启动的服务进程，并比对用户真实配置的哈希（FIN-04）。 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function hashFile(path: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return 'missing';
  }
}

export default async function globalTeardown(): Promise<void> {
  const run = JSON.parse(await readFile(join(process.cwd(), 'e2e-real/.run.json'), 'utf8')) as {
    root: string;
    serverPid: number;
    externalDsh?: { pid: number };
    userHashes: Record<string, string>;
  };
  try {
    process.kill(run.serverPid, 'SIGKILL');
  } catch {
    // 已经退出
  }
  const externalPid = (run as { externalDsh?: { pid: number } }).externalDsh?.pid;
  if (externalPid !== undefined) {
    try {
      process.kill(externalPid, 'SIGKILL');
    } catch {
      // 已经退出
    }
  }
  const after = {
    codex: await hashFile(join(homedir(), '.codex/config.toml')),
    claude: await hashFile(join(homedir(), '.claude/settings.json')),
    dshProfile: await hashFile(join(homedir(), '.dsh/cordis.patch.yml')),
    dshCreds: await hashFile(join(homedir(), '.dsh/.credentials.yaml')),
  };
  const same = JSON.stringify(after) === JSON.stringify(run.userHashes);
  await writeFile(join(run.root, 'user-hashes.json'), JSON.stringify({ before: run.userHashes, after, same }, null, 2));
  if (!same) process.stderr.write('[m8] 用户真实配置在验收期间被改动了（FIN-04 失败）\n');
}
