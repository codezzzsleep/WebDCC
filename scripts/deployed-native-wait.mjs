import { setTimeout as delay } from 'node:timers/promises';

/** Observation deadlines are separate from native execution and provider policy. */
export async function waitForNativeTurn(read, {
  afterSeq = 0, idleTimeoutMs = 150_000, maxDurationMs = 900_000,
  intervalMs = 250, now = Date.now, sleep = delay,
} = {}) {
  if (![idleTimeoutMs, maxDurationMs, intervalMs].every(value => Number.isFinite(value) && value > 0)) throw Error('Invalid native observation deadline');
  const startedAt = now(); let lastProgressAt = startedAt; let previous; let targetTurnId;
  while (true) {
    const { events, requests = [] } = await read();
    if (requests.some(request => request.state === 'uncertain')) throw Error('Uncertain model receipt; paid input will not be repeated');
    targetTurnId ??= events.find(event => event.seq > afterSeq && event.kind === 'user.message' && event.turnId !== null)?.turnId;
    const progress = JSON.stringify([events.at(-1)?.seq ?? 0, requests.map(request => [request.id, request.state,
      request.response?.chunks?.length ?? 0, request.response?.chunks?.at(-1)?.t ?? null])]);
    if (progress !== previous) { previous = progress; lastProgressAt = now(); }
    const done = targetTurnId === undefined ? undefined : events.find(event => event.seq > afterSeq && event.kind === 'turn.completed' && event.turnId === targetTurnId);
    if (done !== undefined) {
      if (done.data.status !== 'completed') throw Error('Official native turn did not complete');
      return events;
    }
    const elapsedMs = now() - startedAt; const idleMs = now() - lastProgressAt;
    const deadline = elapsedMs >= maxDurationMs ? 'absolute' : idleMs >= idleTimeoutMs ? 'idle' : undefined;
    if (deadline !== undefined) throw Object.assign(Error('Native observation deadline reached; native completion is unconfirmed'), {
      observation: { deadline, targetTurnId: targetTurnId ?? null, elapsedMs, idleMs,
        pendingRequestIds: requests.filter(request => request.state === 'in-flight').map(request => request.id) },
    });
    await sleep(intervalMs);
  }
}

/** Already admitted requests must settle before their native transport closes. */
export async function waitForNativeReceipts(read, {
  timeoutMs = 120_000, intervalMs = 250, now = Date.now, sleep = delay,
} = {}) {
  if (![intervalMs].every(value => Number.isFinite(value) && value > 0) || !(timeoutMs === Infinity || Number.isFinite(timeoutMs) && timeoutMs > 0)) throw Error('Invalid receipt observation deadline');
  const startedAt = now();
  while (true) {
    const requests = read();
    const pendingRequestIds = requests.filter(request => request.state === 'in-flight').map(request => request.id);
    const uncertainRequestIds = requests.filter(request => request.state === 'uncertain').map(request => request.id);
    if (pendingRequestIds.length === 0) return { settled: uncertainRequestIds.length === 0, elapsedMs: now() - startedAt, pendingRequestIds, uncertainRequestIds };
    if (now() - startedAt >= timeoutMs) return { settled: false, elapsedMs: now() - startedAt, pendingRequestIds, uncertainRequestIds };
    await sleep(intervalMs);
  }
}
