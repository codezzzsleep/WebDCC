import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestApp } from './helpers.js';
import { codexForkRejectionFixture } from './fixtures/codex-fork-rejection.js';

it.each([false, true])('distinguishes rejected from unknown fork outcomes across restart (uncertain=%s)', async uncertain => {
  const directory = await mkdtemp(join(tmpdir(), 'wdcc-fork-rejection-')); const dbPath = join(directory, 'store.db');
  const first = await createTestApp({}, undefined, {}, { dbPath }); let firstClosed = false;
  try {
    const workspace = first.store.createWorkspace('Fork rejection', directory);
    const source = first.store.createSession({ workspaceId: workspace.id, agent: 'codex', model: 'fixture', accessMode: 'inherit' });
    first.store.updateSession(source.id, { nativeId: 'native-source' });
    first.store.setDraft(source.id, '  preserve source draft\n  ', []);
    const fixture = codexForkRejectionFixture(directory, 'native-source', uncertain); first.manager.registerAdapter(fixture.adapter);
    await first.manager.connectNativeControls(source.id, { commandId: 'connect-before-rejection', action: { type: 'connect' } });
    const snapshot = await first.manager.nativeControls(source.id, true);
    const command = { commandId: 'first-fork-rejection', revision: snapshot.revision, action: { type: 'fork' } };
    const url = `/api/sessions/${source.id}/native/actions`; const headers = { cookie: first.cookie };
    const response = await first.app.inject({ method: 'POST', url, headers, payload: command });
    expect(response.statusCode).toBe(uncertain ? 500 : 409);
    const saved = first.store.nativeActions.get(command.commandId, source.id)!;
    expect(saved).toMatchObject({ state: uncertain ? 'uncertain' : 'failed', error: uncertain ? 'native-outcome-unconfirmed' : 'native-rejected-without-effects' });
    expect((await first.manager.executeNativeControl(source.id, command)).receipt).toEqual(saved);
    expect(fixture.controlCalls()).toBe(1);
    expect(first.store.listSessions(true)).toHaveLength(1);
    await first.close(); firstClosed = true;
    const second = await createTestApp({}, undefined, {}, { dbPath });
    try {
      const recovered = codexForkRejectionFixture(directory); recovered.setReady(); second.manager.registerAdapter(recovered.adapter);
      expect(second.store.nativeActions.get(command.commandId, source.id)).toEqual(saved);
      await second.manager.connectNativeControls(source.id, { commandId: 'connect-after-restart', action: { type: 'connect' } });
      const current = await second.manager.nativeControls(source.id, true);
      const retry = { commandId: 'corrected-fork-after-restart', revision: current.revision, action: { type: 'fork' } };
      if (uncertain) {
        await expect(second.manager.executeNativeControl(source.id, retry)).rejects.toThrow('不能重复提交');
        expect(recovered.controlCalls()).toBe(0);
      } else {
        const result = await second.manager.executeNativeControl(source.id, retry);
        expect(result.receipt).toMatchObject({ state: 'completed', continuation: { sourceNativeId: 'native-source', nativeId: 'native-fork-1' } });
        expect(recovered.controlCalls()).toBe(1); expect(recovered.forkCalls()).toBe(1);
        expect(await second.manager.executeNativeControl(source.id, retry)).toEqual({ receipt: result.receipt });
        expect(recovered.forkCalls()).toBe(1);
      }
      expect(second.store.getSession(source.id)?.nativeId).toBe('native-source');
      expect(second.store.getDraft(source.id).text).toBe('  preserve source draft\n  ');
      await second.manager.send(source.id, { text: 'Normal new message' }, 'normal-message-after-control');
      expect(recovered.sends).toHaveLength(1);
    } finally { await second.close(); }
  } finally { if (!firstClosed) await first.close(); await rm(directory, { recursive: true, force: true }); }
});
