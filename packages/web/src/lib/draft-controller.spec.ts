import { expect, it } from 'vitest';
import { DraftConflictError, DraftController, type InputDraft, type InputDraftStore } from './draft-controller.js';

type Part = { type: string; fileId?: string };
function backend() {
  const values = new Map<string, InputDraft<Part>>();
  const store: InputDraftStore<Part> = {
    async getDraft(id) { return values.get(id); },
    async putDraft(draft, expected) {
      if ((values.get(draft.sessionId)?.revision ?? 0) !== expected) throw new DraftConflictError();
      values.set(draft.sessionId, structuredClone(draft));
    },
  };
  return { values, store };
}
it('a late A read cannot overwrite B text or attachments, and reopened drafts restore both', async () => {
  const { store, values } = backend(); let finish!: (draft: InputDraft<Part>) => void;
  const load = store.getDraft;
  store.getDraft = async id => id === 'A' ? new Promise(resolve => { finish = resolve; }) : load(id);
  const drafts = new DraftController(store);
  const opening = drafts.open('A');
  await drafts.open('B');
  drafts.update('  B\r\ntext  ', { version: 1, parts: [{ type: 'image', fileId: 'B-image' }] });
  await drafts.flush();
  finish({ sessionId: 'A', revision: 7, text: 'A-old', contentParts: { version: 1, parts: [{ type: 'image', fileId: 'A-image' }] }, updatedAt: 1 });
  await opening;
  expect(drafts.snapshot()).toMatchObject({ sessionId: 'B', text: '  B\r\ntext  ', contentParts: { parts: [{ fileId: 'B-image' }] } });
  const restored = new DraftController({ ...store, getDraft: async id => values.get(id) });
  await restored.open('B');
  expect(restored.snapshot()).toMatchObject({ text: '  B\r\ntext  ', contentParts: { parts: [{ fileId: 'B-image' }] } });
});
it('CAS conflict preserves unsaved text and attachment identity without blindly overwriting another tab', async () => {
  const { store, values } = backend(); const drafts = new DraftController(store);
  await drafts.open('A');
  values.set('A', { sessionId: 'A', revision: 1, text: 'other tab', contentParts: { version: 1, parts: [] }, updatedAt: 1 });
  drafts.update('mine', { version: 1, parts: [{ type: 'file', fileId: 'my-file' }] });
  await expect(drafts.flush()).rejects.toBeInstanceOf(DraftConflictError);
  expect(drafts.snapshot()).toMatchObject({ text: 'mine', contentParts: { parts: [{ fileId: 'my-file' }] } });
  await expect(drafts.retrySave()).rejects.toBeInstanceOf(DraftConflictError);
  expect(values.get('A')?.text).toBe('other tab');
  await drafts.open('B'); await drafts.open('A');
  expect(drafts.snapshot()?.text).toBe('mine');
  await drafts.resolveConflict('stored'); expect(drafts.snapshot()?.text).toBe('other tab');
  values.set('A', { sessionId: 'A', revision: 2, text: 'other tab again', contentParts: { version: 1, parts: [] }, updatedAt: 2 });
  drafts.update('my final choice', { version: 1, parts: [{ type: 'file', fileId: 'my-file' }] });
  await expect(drafts.flush()).rejects.toBeInstanceOf(DraftConflictError);
  await drafts.resolveConflict('local'); await drafts.flush();
  expect(values.get('A')).toMatchObject({ revision: 3, text: 'my final choice', contentParts: { parts: [{ fileId: 'my-file' }] } });
});
it('durable-save failure stays visible, retries the current bytes, and clears only an unchanged submission revision', async () => {
  const { store, values } = backend(); const put = store.putDraft; let fail = true;
  store.putDraft = async (draft, expected) => { if (fail) throw new Error('quota'); return put(draft, expected); };
  const drafts = new DraftController(store); await drafts.open('A');
  drafts.update('keep', { version: 1, parts: [{ type: 'image', fileId: 'image' }] });
  await expect(drafts.flush()).rejects.toThrow('quota');
  fail = false; await drafts.retrySave();
  expect(values.get('A')?.text).toBe('keep');
  const token = drafts.token()!; drafts.update('typed while sending');
  expect(drafts.clearIfUnchanged(token)).toBe(false);
  expect(drafts.snapshot()?.text).toBe('typed while sending');
  expect(drafts.clearIfUnchanged(drafts.token()!)).toBe(true); await drafts.flush();
  expect(values.get('A')).toMatchObject({ text: '', contentParts: { parts: [] } });
});
it('editing while a failed save is retried remains in the durable write queue', async () => {
  const { store, values } = backend(); const put = store.putDraft; const get = store.getDraft;
  let fail = true; let retrying = false; let started!: () => void; let finish!: () => void;
  const readStarted = new Promise<void>(resolve => { started = resolve; });
  const readReleased = new Promise<void>(resolve => { finish = resolve; });
  store.putDraft = async (draft, expected) => { if (fail) throw new Error('quota'); return put(draft, expected); };
  store.getDraft = async id => { if (retrying) { started(); await readReleased; } return get(id); };
  const drafts = new DraftController(store); await drafts.open('A'); drafts.update('first');
  await expect(drafts.flush()).rejects.toThrow('quota');
  fail = false; retrying = true;
  const retry = drafts.retrySave(); await readStarted;
  drafts.update('new bytes\r\n', { version: 1, parts: [{ type: 'image', fileId: 'new-image' }] });
  finish(); await retry; await drafts.flush();
  expect(values.get('A')).toMatchObject({ revision: 2, text: 'new bytes\r\n', contentParts: { parts: [{ fileId: 'new-image' }] } });
  expect(drafts.snapshot()).toMatchObject({ revision: 2, text: 'new bytes\r\n' });
  expect(drafts.error()).toBeUndefined();
});
