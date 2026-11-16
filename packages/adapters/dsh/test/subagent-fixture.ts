/** Controlled native producer over real HTTP/WS, using the locked RPC contract. */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { DshSubagentState, DshSubagentRecord, AgentAdapter, SessionDto } from '@webdcc/protocol';
import { DshAdapter } from '../src/adapter.js';
import type { DshHostClient } from '../src/host.js';
import type { DshPageRequest } from '../src/contracts.js';

export const childRecord = (seq: number, type: string, data: unknown): DshSubagentRecord => ({ type: 'event', event: { seq, type, time: 1000 + seq, data } });

export async function createDshSubagentFixture(localId = 'parent') {
  const parentId = 'native-parent';
  let catalog = [
    { id: 'reviewer', createdAt: 1000, name: 'reviewer', label: 'Review independently', mode: 'continuable' },
    { id: 'failing', createdAt: 1001, name: 'failing', label: 'Partial failure', mode: 'continuable' },
    { id: 'once', createdAt: 1002, label: 'One shot', mode: 'one-shot' },
    { id: 'external', createdAt: 1003, name: 'external', label: 'External work', mode: 'external' },
  ];
  const states = new Map<string, DshSubagentState>();
  const descriptorSeqs = new Map<string, number | null>();
  const records = new Map<string, DshSubagentRecord[]>();
  for (const id of ['reviewer', 'failing', 'once']) {
    const rows = [
      childRecord(0, 'subagent/descriptor', { version: id === 'once' ? 0 : 3, mode: id === 'once' ? 'one-shot' : 'continuable', label: id, provider: 'fork' }),
      childRecord(1, 'turn/start', { turn: 1 }),
      childRecord(2, 'user/message', { id: `${id}-input`, source: { kind: 'user', rpcId: `${id}-request` }, content: [{ type: 'text', text: `${id} original input` }] }),
      childRecord(3, 'tool/call', { callId: `${id}-tool`, name: 'read', arguments: '{"file_path":"child.ts"}' }),
      childRecord(4, 'tool/result', { toolCallId: `${id}-tool`, message: { toolCallId: `${id}-tool`, content: [{ type: 'text', text: 'native child file result' }], isError: false } }),
      childRecord(5, 'assistant/message', { turn: 1, message: { id: `${id}-message`, content: [{ type: 'reasoning', text: 'child thinking' }, { type: 'text', text: id === 'failing' ? 'PARTIAL CHILD OUTPUT' : `${id.toUpperCase()} CHILD ONLY FINAL` }] } }),
      childRecord(6, 'turn/end', { turn: 1, reason: { kind: id === 'failing' ? 'max-tokens' : 'completed' } }),
    ];
    states.set(id, { cursor: 6, active: false, running: false, pendingInput: [], queue: null });
    records.set(id, rows);
    descriptorSeqs.set(id, 0);
  }
  let pageSize = 3;
  const calls: { rpcId: string; method: string; args: Record<string, unknown> }[] = [];
  const holds: { endpoint: string; matches?: string; hit: () => void; release: Promise<void> }[] = [];
  const releases: (() => void)[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { rpcId: string; method: string; payload: { args: Record<string, unknown> } };
      const args = body.payload.args;
      calls.push({ rpcId: body.rpcId, method: body.method, args: structuredClone(args) });
      const target = args['request'] as { sessionId?: string } | undefined;
      let value: unknown;
      if (body.method === 'commands/list') value = { commands: [] };
      else if (body.method === 'session/projections' && target?.sessionId === parentId) value = { kind: 'sequenced', asOfSeq: 10, values: { subagentCatalog: structuredClone(catalog) } };
      else if (body.method === 'session/projections') value = { kind: 'sequenced', asOfSeq: states.get(target?.sessionId ?? '')?.cursor ?? -1, values: {
        subagent: descriptorSeqs.get(target?.sessionId ?? '') === null ? null : { seq: descriptorSeqs.get(target?.sessionId ?? '') ?? 0, mode: catalog.find(child => child.id === target?.sessionId)?.mode, label: target?.sessionId },
      } };
      else if (body.method === 'session/state') value = structuredClone(states.get(target?.sessionId ?? ''));
      else if (body.method === 'session/page') {
        const input = args['request'] as DshPageRequest;
        if (input.address.kind !== 'subagent' || input.address.parentSessionId !== parentId) throw new Error('fixture rejected incorrect direct parent');
        const all = records.get(input.address.childSessionId);
        if (all === undefined) throw new Error('fixture child absent');
        const cursor = input.throughSeq ?? all.at(-1)!.event.seq;
        const eligible = all.filter(record => record.event.seq <= cursor && (input.beforeSeq === undefined || record.event.seq < input.beforeSeq));
        const window = eligible.slice(-Math.min(input.maxMessages ?? 100, pageSize));
        value = { cursor, records: structuredClone(window), hasMore: window.length < eligible.length };
      } else throw new Error(`fixture does not implement ${body.method}`);
      const holdIndex = holds.findIndex(hold => hold.endpoint === body.method && (hold.matches === undefined || JSON.stringify(args).includes(hold.matches)));
      if (holdIndex >= 0) { const held = holds.splice(holdIndex, 1)[0]!; held.hit(); await held.release; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
    })().catch(error => { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); });
  });
  const sockets = new WebSocketServer({ server });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture listener missing');
  const native = DshAdapter.replay(localId, parentId);
  const adapter = native.adapter;
  const client = (adapter as unknown as { newHost(endpoint: string): DshHostClient }).newHost(`http://127.0.0.1:${address.port}/`);
  Object.assign(adapter, { client });
  await client.connect();
  adapter.probe = async () => ({ installed: true, version: '0.2.2-rc.1', pinnedVersion: '0.2.2-rc.1', auth: 'ok' });
  adapter.accessModes = async () => [{ id: 'inherit', label: '原生默认' }];
  adapter.listModels = async () => [];
  adapter.resume = async () => undefined;
  return { adapter, native, client, parentId, states, descriptorSeqs, records, calls,
    setPageSize(value: number) { pageSize = value; },
    setCatalog(value: typeof catalog) { catalog = value; },
    disconnect() { for (const socket of sockets.clients) socket.terminate(); },
    hold(endpoint: string, matches?: string) {
      let release!: () => void; let hit!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      const seen = new Promise<void>(resolve => { hit = resolve; });
      releases.push(release); holds.push({ endpoint, matches, hit, release: released });
      return { seen, release };
    },
    async close() {
      releases.forEach(release => release());
      await adapter.shutdown(); await client.close();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/** Bind a controlled existing Session through the actual manager ownership path. */
export function bindDshSubagentFixture(manager: { registerAdapter(adapter: AgentAdapter): void }, session: SessionDto, cwd: string, adapter: DshAdapter, nativeId: string): void {
  manager.registerAdapter(adapter);
  (manager as unknown as { ensureRuntime(session: SessionDto, adapter: AgentAdapter, cwd: string, nativeId: string): unknown }).ensureRuntime(session, adapter, cwd, nativeId);
}
