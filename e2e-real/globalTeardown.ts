/** 结束本套件自己启动的服务进程，并比对用户真实配置的哈希（FIN-04）。 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function hashFile(path: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return 'missing';
  }
}

function descendants(root: number): number[] {
  const parentOf = new Map<number, number>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      const fields = stat.slice(end + 2).split(' ');
      parentOf.set(Number(entry), Number(fields[1]));
    } catch {
      // 进程在扫描期间退出
    }
  }
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift();
    if (parent === undefined) continue;
    for (const [pid, ppid] of parentOf) {
      if (ppid !== parent || found.includes(pid)) continue;
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

function killTree(root: number): void {
  for (const pid of descendants(root).sort((a, b) => b - a)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出
    }
  }
  try {
    process.kill(root, 'SIGKILL');
  } catch {
    // 已退出
  }
}

export default async function globalTeardown(): Promise<void> {
  const run = JSON.parse(await readFile(join(process.cwd(), 'e2e-real/.run.json'), 'utf8')) as {
    root: string;
    serverPid: number;
    externalDsh?: { pid: number };
    userHashes: Record<string, string>;
  };
  killTree(run.serverPid);
  const externalPid = (run as { externalDsh?: { pid: number } }).externalDsh?.pid;
  if (externalPid !== undefined) killTree(externalPid);
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
