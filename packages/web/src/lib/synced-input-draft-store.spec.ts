import { expect, it, vi } from 'vitest';
import type { DraftDto } from '@webdcc/protocol';
import type { InputDraft } from './draft-controller.js';
import type { PreparedPart } from './composer-input-controller.js';
import type { RemoteDraftBaseline, InputPreparationStore } from './input-preparation-store.js';
import { UploadController } from './upload-controller.js';
import { SyncedInputDraftStore } from './synced-input-draft-store.js';

const mocks = vi.hoisted(() => ({ draft: vi.fn(), saveInputDraft: vi.fn() }));
vi.mock('./api.js', () => ({ api: mocks }));
function fixture() {
  const values = new Map<string, InputDraft<PreparedPart>>(); const baselines = new Map<string, RemoteDraftBaseline>();
  const local = { getDraft: async (id: string) => values.get(id), putDraft: async (draft: InputDraft<PreparedPart>) => { values.set(draft.sessionId, structuredClone(draft)); },
    getRemoteDraft: async (id: string) => baselines.get(id), putRemoteDraft: async (baseline: RemoteDraftBaseline) => { baselines.set(baseline.sessionId, structuredClone(baseline)); },
    compareRemoteDraft: async (baseline: RemoteDraftBaseline, expected?: RemoteDraftBaseline) => {
      const current = baselines.get(baseline.sessionId);
      if (JSON.stringify(current) !== JSON.stringify(expected) || current !== undefined && baseline.revision < current.revision) throw Object.assign(new Error('baseline changed'), { status: 409 });
      baselines.set(baseline.sessionId, structuredClone(baseline));
    },
    adoptRemoteDraft: async (baseline: RemoteDraftBaseline, expectedRevision?: number, expected?: RemoteDraftBaseline) => {
      const current = values.get(baseline.sessionId); const currentBaseline = baselines.get(baseline.sessionId);
      if (current?.revision !== expectedRevision || JSON.stringify(currentBaseline) !== JSON.stringify(expected)
        || currentBaseline !== undefined && baseline.revision < currentBaseline.revision) throw Object.assign(new Error('baseline changed'), { status: 409 });
      const selected: InputDraft<PreparedPart> = { sessionId: baseline.sessionId, revision: expectedRevision === undefined ? 0 : expectedRevision + 1,
        text: baseline.text, contentParts: baseline.contentParts!, updatedAt: Date.now() };
      values.set(baseline.sessionId, structuredClone(selected)); baselines.set(baseline.sessionId, structuredClone(baseline)); return selected;
    },
    getUpload: async () => undefined, listUploads: async () => [], putUpload: async () => undefined };
  const uploads = new UploadController({ store: local });
  return { local, values, baselines, synced: new SyncedInputDraftStore(local as unknown as InputPreparationStore<PreparedPart>, uploads) };
}
const remote = (text: string, revision: number): DraftDto => ({ text, revision, fileIds: [], updatedAt: new Date().toISOString(), contentParts: { version: 1, parts: text === '' ? [] : [{ type: 'text', text }] } });

it('a remote CAS conflict preserves local input and either explicit choice uses the fresh server revision', async () => {
  mocks.draft.mockResolvedValue(remote('', 0)); mocks.saveInputDraft.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
  const { synced, values, baselines } = fixture();
  await synced.getDraft('A');
  await synced.putDraft({ sessionId: 'A', revision: 1, text: 'my draft', contentParts: { version: 1, parts: [] }, updatedAt: 1 }, 0);
  await synced.sync('A');
  expect(synced.state('A')).toMatchObject({ conflict: true }); expect(values.get('A')?.text).toBe('my draft');
  mocks.draft.mockResolvedValue(remote('other device', 4));
  mocks.saveInputDraft.mockResolvedValue(remote('my draft', 5));
  await synced.useLocal('A');
  expect(mocks.saveInputDraft).toHaveBeenLastCalledWith('A', 'my draft', { version: 1, parts: [{ type: 'text', text: 'my draft' }] }, 4);
  expect(synced.state('A')).toMatchObject({ pending: false }); expect(baselines.get('A')?.revision).toBe(5);
  mocks.draft.mockResolvedValue(remote('new remote', 6));
  expect(await synced.readRemote('A')).toMatchObject({ text: 'new remote' });
  expect(values.get('A')?.text).toBe('my draft');
});
it('refresh keeps a durably cleared local draft and synchronizes empty content instead of reviving old remote text', async () => {
  const { synced, values, baselines } = fixture();
  values.set('A', { sessionId: 'A', revision: 3, text: '', contentParts: { version: 1, parts: [] }, updatedAt: 1 });
  baselines.set('A', { sessionId: 'A', revision: 8, text: 'already sent', contentParts: { version: 1, parts: [{ type: 'text', text: 'already sent' }] } });
  mocks.draft.mockResolvedValue(remote('already sent', 8)); mocks.saveInputDraft.mockResolvedValue(remote('', 9));
  expect(await synced.getDraft('A')).toMatchObject({ text: '', revision: 3 });
  await synced.sync('A'); expect(mocks.saveInputDraft).toHaveBeenLastCalledWith('A', '', { version: 1, parts: [] }, 8);
  expect(values.get('A')?.text).toBe(''); expect(baselines.get('A')?.text).toBe('');
});
it('a delayed cloud read cannot replace a newer sync baseline and strand a later clear behind stale CAS', async () => {
  const { synced, values, baselines } = fixture();
  let server = remote('chosen remote draft', 4); const captured = structuredClone(server);
  values.set('A', { sessionId: 'A', revision: 5, text: server.text, contentParts: server.contentParts!, updatedAt: 1 });
  baselines.set('A', { sessionId: 'A', revision: server.revision, text: server.text, contentParts: server.contentParts });
  let began!: () => void; let release!: () => void;
  const reading = new Promise<void>(resolve => { began = resolve; });
  mocks.draft.mockImplementationOnce(() => { began(); return new Promise<DraftDto>(resolve => { release = () => resolve(captured); }); });
  mocks.saveInputDraft.mockImplementation(async (_id: string, text: string, contentParts: DraftDto['contentParts'], expected: number) => {
    if (expected !== server.revision) throw Object.assign(new Error('stale CAS'), { status: 409 });
    server = { ...remote(text, server.revision + 1), contentParts }; return structuredClone(server);
  });
  const oldRead = synced.readRemote('A'); await reading;
  values.set('A', { sessionId: 'A', revision: 6, text: 'temporary local draft', contentParts: { version: 1, parts: [] }, updatedAt: 2 });
  await synced.sync('A');
  expect(server.revision).toBe(5);
  release(); const selected = await oldRead;
  values.set('A', { sessionId: 'A', revision: 7, text: selected.text, contentParts: selected.contentParts, updatedAt: 3 });
  await synced.sync('A');
  values.set('A', { sessionId: 'A', revision: 8, text: '', contentParts: { version: 1, parts: [] }, updatedAt: 4 });
  await synced.sync('A');
  expect(server.text).toBe('');
  expect(baselines.get('A')?.revision).toBe(server.revision);
  expect(synced.state('A')).toEqual(expect.objectContaining({ pending: false }));
});
it('a cloud choice holds the queue until its draft and baseline are adopted, then a newer clear reaches the server', async () => {
  const { synced, values, baselines } = fixture();
  let server = remote('chosen remote draft', 4);
  values.set('A', { sessionId: 'A', revision: 3, text: 'temporary local draft', contentParts: { version: 1, parts: [] }, updatedAt: 1 });
  baselines.set('A', { sessionId: 'A', revision: 4, text: server.text, contentParts: server.contentParts });
  let began!: () => void; let release!: () => void;
  const reading = new Promise<void>(resolve => { began = resolve; });
  mocks.draft.mockImplementationOnce(() => { began(); return new Promise<DraftDto>(resolve => { release = () => resolve(structuredClone(server)); }); });
  const puts: string[] = [];
  mocks.saveInputDraft.mockImplementation(async (_id: string, text: string, contentParts: DraftDto['contentParts'], expected: number) => {
    if (expected !== server.revision) throw Object.assign(new Error('stale CAS'), { status: 409 });
    puts.push(text); server = { ...remote(text, server.revision + 1), contentParts }; return structuredClone(server);
  });
  const selecting = synced.useRemote('A', 3); await reading;
  const queued = synced.sync('A');
  await Promise.resolve(); expect(puts).toEqual([]);
  release(); const selected = await selecting; await queued;
  expect(selected).toMatchObject({ revision: 4, text: 'chosen remote draft' });
  expect(puts).toEqual([]);
  await synced.putDraft({ sessionId: 'A', revision: 5, text: '', contentParts: { version: 1, parts: [] }, updatedAt: 2 }, 4);
  await synced.sync('A');
  expect(server.text).toBe(''); expect(baselines.get('A')?.revision).toBe(server.revision);
});
it('an older explicit cloud choice cannot lower a newer baseline or partially change the local draft', async () => {
  const { synced, values, baselines } = fixture();
  const local = { sessionId: 'A', revision: 3, text: 'keep local', contentParts: { version: 1 as const, parts: [] }, updatedAt: 1 };
  const baseline = { sessionId: 'A', revision: 5, text: 'newer remote', contentParts: remote('newer remote', 5).contentParts };
  values.set('A', structuredClone(local)); baselines.set('A', structuredClone(baseline));
  mocks.draft.mockResolvedValue(remote('old remote', 4));
  await expect(synced.useRemote('A', 3)).rejects.toMatchObject({ status: 409 });
  expect(values.get('A')).toEqual(local); expect(baselines.get('A')).toEqual(baseline);
});
