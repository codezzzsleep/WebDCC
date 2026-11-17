import { join } from 'node:path';
import type { AgentId } from '@webdcc/protocol';
import { createTestApp } from '../helpers.js';

const ctx = await createTestApp({}, undefined, {}, { dbPath: join(process.argv[2]!, 'owners.sqlite') });
let resumes = 0;
for (const agent of ['codex', 'claude-code', 'dsh'] as const) {
  const adapter = ctx.manager.adapter(agent)!;
  adapter.resume = async () => { resumes++; await new Promise(resolve => setTimeout(resolve, 30)); };
  adapter.send = async () => undefined;
}
// Pause an actual read inside acquisition. With a deferred transaction,
// the other connection may commit while this snapshot is held. A writer
// transaction must serialize before reaching this same unchanged pause.
let acquiring = false;
const acquire = ctx.store.nativeOwners.acquire.bind(ctx.store.nativeOwners);
ctx.store.nativeOwners.acquire = (...args) => {
  acquiring = true;
  try { return acquire(...args); } finally { acquiring = false; }
};
const get = ctx.store.nativeOwners.get.bind(ctx.store.nativeOwners);
ctx.store.nativeOwners.get = sessionId => {
  const owner = get(sessionId);
  if (acquiring) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  return owner;
};
interface Request { trial: number; sessionId: string; nativeId: string; agent: AgentId; ownerId: string; startAt: number; mode: 'api' | 'http'; stop?: boolean }
process.send?.({ ready: true, pid: process.pid });
process.on('message', (input: Request) => { void run(input); });
async function run(input: Request): Promise<void> {
  if (input.stop) { await ctx.close(); process.exit(0); }
  const delay = input.startAt - Date.now();
  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  const before = resumes;
  if (input.mode === 'http') {
    const command = { op: 'send', sessionId: input.sessionId, clientCommandId: input.ownerId, text: 'concurrent owner input' };
    const response = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } });
    process.send?.({ trial: input.trial, pid: process.pid, statusCode: response.statusCode, body: response.json(), resumes: resumes - before,
      owner: ctx.store.nativeOwners.get(input.sessionId), journal: ctx.store.journal.get(input.ownerId) });
    return;
  }
  try {
    const identity = ctx.store.nativeOwners.acquire(input.ownerId, input.sessionId, input.agent, input.nativeId);
    process.send?.({ trial: input.trial, pid: process.pid, identity, owner: ctx.store.nativeOwners.get(input.sessionId), resumes: resumes - before });
  } catch (error) {
    const value = error as Error & { code?: string; statusCode?: number };
    process.send?.({ trial: input.trial, pid: process.pid, error: value.message, code: value.code, statusCode: value.statusCode, resumes: resumes - before });
  }
}
