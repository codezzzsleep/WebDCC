import process from 'node:process';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

async function identity(pid) {
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = value.slice(value.lastIndexOf(')') + 2).split(' ');
    return { pid, parent: Number(fields[1]), state: fields[0], start: fields[19] };
  } catch { return undefined; }
}

async function ownedDsh(pid, home) {
  const first = await identity(pid);
  if (!first || first.state === 'Z' || first.state === 'X' || pid === process.pid) return undefined;
  try {
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    const env = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0');
    if (!argv.includes('web') || !argv.some(arg => arg === 'dsh' || arg.endsWith('/dsh')) || !env.includes('DSH_HOME=' + home)) return undefined;
  } catch { return undefined; }
  let parent = first.parent;
  for (let depth = 0; depth < 64 && parent > 1; depth++) {
    if (parent === process.pid) return first;
    const value = await identity(parent);
    if (!value || value.parent === parent) return undefined;
    parent = value.parent;
  }
  return undefined;
}

/** Stop only this verifier's surviving native Web descendants in its private
 * DSH_HOME. Recheck ownership and PID start time before each signal. */
export async function stopOwnedDsh(home) {
  if (process.platform !== 'linux' || !home) return [];
  const stopped = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry), first = await ownedDsh(pid, home);
    if (!first) continue;
    const same = async () => (await ownedDsh(pid, home))?.start === first.start;
    if (!await same()) continue;
    try { process.kill(pid, 'SIGTERM'); } catch { continue; }
    for (let attempt = 0; attempt < 10 && await same(); attempt++) await delay(50);
    if (await same()) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      for (let attempt = 0; attempt < 20 && await same(); attempt++) await delay(50);
    }
    if (await same()) throw new Error(`Private native verifier process ${pid} did not exit`);
    stopped.push(pid);
  }
  return stopped;
}

/** Close managed writers, then metadata sidecars and any surviving descendants. */
export async function closeVerifiedServer(server, home) {
  const adapter = server?.manager.adapter('dsh');
  await server?.close();
  await adapter?.shutdown();
  return stopOwnedDsh(home);
}

/** Fence native discovery that settles while the verifier transport closes. */
export async function finalizeVerifiedServer(server, home, closeTransport) {
  const adapter = server?.manager.adapter('dsh');
  const stopped = [];
  try { stopped.push(...await closeVerifiedServer(server, home)); }
  finally {
    try { await closeTransport(); }
    finally {
      await adapter?.shutdown();
      stopped.push(...await stopOwnedDsh(home));
    }
  }
  return [...new Set(stopped)];
}
