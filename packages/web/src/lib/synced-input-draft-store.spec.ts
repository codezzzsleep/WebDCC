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
  expect(synced.state('A')).toEqual({ pending: false }); expect(baselines.get('A')?.revision).toBe(5);
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
