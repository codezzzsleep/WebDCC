/** Controlled current-child opening over real mux. No native/model execution. */
import { createDshSubagentFixture, childRecord } from './subagent-fixture.js';

export async function createChildActiveOutputFixture(localId = 'parent') {
  const fixture = await createDshSubagentFixture(localId);
  fixture.setPageSize(200);
  const assistants = fixture.assistants;
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
  return fixture;
}
