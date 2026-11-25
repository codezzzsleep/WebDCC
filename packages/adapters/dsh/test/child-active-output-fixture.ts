/** Controlled current-child opening over real mux. No native/model execution. */
import { createDshSubagentFixture, childRecord } from './subagent-fixture.js';
import type { DshAssistantBaseline } from '../src/assistant.js';
import type { DshFollowRequest } from '../src/contracts.js';

export async function createChildActiveOutputFixture(localId = 'parent') {
  const fixture = await createDshSubagentFixture(localId);
  fixture.setPageSize(200);
  const assistants = new Map<string, DshAssistantBaseline>();
  const opens: { streamId: string; request: DshFollowRequest }[] = [];
  const canceled: string[] = [];
  for (const child of ['reviewer', 'failing']) {
    const state = fixture.states.get(child)!;
    state.cursor = 7; state.active = true; state.running = true;
    fixture.records.get(child)!.push(childRecord(7, 'turn/start', { turn: 2 }));
    assistants.set(child, { revision: 2, activeAttempt: {
      attemptId: 'same-native-attempt-id', startedAfterSeq: 7, turn: 2, step: 1, nextIndex: 2,
      stream: [{ type: 'chunk', time: 2000, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'text-chunks', time0: 2001, index: 0, dt: [], texts: [`${child} partial🐈\r\n `] }],
    } });
  }
  for (const socket of fixture.socketServer.clients) socket.on('message', raw => {
    const frame = JSON.parse(String(raw)) as { type: string; streamId: string; endpoint?: string; payload?: { args: { request: DshFollowRequest } } };
    if (frame.type === 'cancel') { canceled.push(frame.streamId); return; }
    if (frame.type !== 'open' || frame.endpoint !== 'session/follow') return;
    const request = frame.payload?.args.request;
    if (request?.address.kind !== 'subagent' || request.address.parentSessionId !== fixture.parentId || request.activate !== false || request.assistantStream !== true)
      throw new Error('Controlled child output requires the original passive native address');
    opens.push({ streamId: frame.streamId, request: structuredClone(request) });
    const child = request.address.childSessionId;
    const records = structuredClone(fixture.records.get(child) ?? []);
    const descriptor = fixture.descriptorSeqs.get(child);
    socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'snapshot', header: { id: child },
      cursor: fixture.states.get(child)?.cursor ?? -1, records, hasMore: false,
      projections: { asOfSeq: fixture.states.get(child)?.cursor ?? -1, values: { subagent: { seq: descriptor, mode: request.address.mode } } },
      assistantStream: structuredClone(assistants.get(child) ?? { revision: 0 }),
    } }));
  });
  return { ...fixture, assistants, opens, canceled };
}
