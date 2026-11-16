import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { createTestApp, seedWorkspaceAndSession } from './helpers.js';

it('a versioned command shared by 100 HTTP and 100 WS submissions executes once and rejects changed content', async () => {
  const ctx = await createTestApp({ delayMs: 100 }); let socket: WebSocket | undefined;
  try {
    const { sessionId } = await seedWorkspaceAndSession(ctx, 'claude-code');
    const adapter = ctx.manager.adapter('claude-code')!; const send = adapter.send.bind(adapter); let executions = 0;
    adapter.send = async (id, input) => { executions++; await send(id, input); };
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    socket = new WebSocket(base.replace('http:', 'ws:') + '/api/ws', { headers: { cookie: ctx.cookie } });
    const acks: unknown[] = [];
    socket.on('message', data => {
      const message = JSON.parse(String(data)) as { op?: string; clientCommandId?: string; result?: unknown };
      if (message.op === 'ack' && message.clientCommandId === 'shared-digest-command') acks.push(message.result);
    });
    await once(socket, 'open');
    socket.send(JSON.stringify({ op: 'hello', clientId: 'digest-peer', feedAfter: 0, subscribe: [] }));
    const command = { op: 'send', sessionId, clientCommandId: 'shared-digest-command', text: 'preserved original ä/z input' };
    const requests = Array.from({ length: 100 }, () => ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command } }));
    for (let i = 0; i < 100; i++) socket.send(JSON.stringify({ op: 'command', command }));
    const responses = await Promise.all(requests);
    await expect.poll(() => acks.length).toBe(100);
    expect(executions).toBe(1); expect(new Set([...responses.map(response => response.body), ...acks.map(ack => JSON.stringify(ack))]).size).toBe(1);
    expect(ctx.store.allEvents(sessionId).filter(event => event.kind === 'user.message')).toHaveLength(1);
    expect(ctx.store.journal.get(command.clientCommandId)?.payloadHash).toMatch(/^sha256-json-v2:[0-9a-f]{64}$/);
    const conflict = await ctx.app.inject({ method: 'POST', url: '/api/commands', headers: { cookie: ctx.cookie }, payload: { command: { ...command, text: 'changed original input' } } });
    expect(conflict.statusCode).toBe(409); expect(conflict.json()).toMatchObject({ ok: false, code: 'command-conflict' });
    const evidence = process.env['WDCC_COMMAND_DIGEST_EVIDENCE_DIR'];
    if (evidence !== undefined) await writeFile(join(evidence, 'http-ws-admission.json'), JSON.stringify({ source: 'actual local HTTP+WS/FakeAdapter',
      httpResponses: responses.map(response => response.json()), websocketAcks: acks, executions, originalCommand: command,
      persisted: ctx.store.journal.get(command.clientCommandId), userEvents: ctx.store.allEvents(sessionId).filter(event => event.kind === 'user.message'),
      conflict: conflict.json(), newOfficialAgentTasks: 0, newProviderCalls: 0 }, null, 2));
  } finally { socket?.terminate(); await ctx.close(); }
}, 30_000);
