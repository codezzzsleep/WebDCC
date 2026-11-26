import { expect, it } from 'vitest';
import { ComposerInputController, type ComposerInputCapabilities, type PreparedPart } from './composer-input-controller.js';
import { DraftController, type InputDraft } from './draft-controller.js';
import { UploadController, type UploadTask } from './upload-controller.js';

function controls() {
  const draftValues = new Map<string, InputDraft<PreparedPart>>(); const tasks = new Map<string, UploadTask>();
  const drafts = new DraftController<PreparedPart>({ getDraft: async id => draftValues.get(id), putDraft: async draft => { draftValues.set(draft.sessionId, structuredClone(draft)); } });
  const uploads = new UploadController({ store: { getUpload: async id => tasks.get(id), listUploads: async id => [...tasks.values()].filter(task => task.sessionId === id), putUpload: async task => { tasks.set(task.id, task); } } });
  const capability: ComposerInputCapabilities = { contentTypes: ['text', 'image', 'file'], inputModalities: ['text', 'image'], intents: ['send', 'queue', 'steer'], running: false };
  return { drafts, uploads, tasks, capability, composer: new ComposerInputController(drafts, uploads, () => capability) };
}
it('click and Enter share the upload guard and cannot enqueue a missing attachment', async () => {
  const { drafts, uploads, tasks, composer } = controls(); await drafts.open('A');
  tasks.set('task', { id: 'task', sessionId: 'A', state: 'uploading', kind: 'image', name: 'a.png', mime: 'image/png', size: 1, sha256: 'a'.repeat(64), received: [], updatedAt: 1 });
  await uploads.restore('A');
  drafts.update('  original\r\n  ', { version: 1, parts: [{ type: 'image', uploadTaskId: 'task' }] });
  let enqueued = 0;
  expect(composer.reason('send')).toBeDefined();
  expect(await composer.submit('send', async () => { enqueued++; return { commandId: 'unexpected' }; })).toMatchObject({ submitted: false });
  expect(enqueued).toBe(0); expect(drafts.snapshot()?.text).toBe('  original\r\n  ');
});
it('pure-image submission resolves a durable upload fileId and refuses a model without declared image support', async () => {
  const { drafts, uploads, tasks, composer, capability } = controls(); await drafts.open('A');
  tasks.set('task', { id: 'task', sessionId: 'A', state: 'completed', kind: 'image', fileId: 'actual-image', name: 'a.png', mime: 'image/png', size: 1, sha256: 'a'.repeat(64), received: [], updatedAt: 1 });
  await uploads.restore('A'); drafts.update('', { version: 1, parts: [{ type: 'image', uploadTaskId: 'task' }] });
  capability.inputModalities = ['text']; expect(composer.reason('send')).toContain('未声明');
  capability.inputModalities = ['text', 'image'];
  let sent: unknown;
  expect(await composer.submit('send', async input => { sent = input; return { commandId: 'saved-command' }; })).toEqual({ submitted: true });
  expect(sent).toMatchObject({ sessionId: 'A', text: '', contentParts: { version: 1, parts: [{ type: 'image', fileId: 'actual-image' }] } });
  expect(drafts.snapshot()?.contentParts.parts).toEqual([]);
});
it('late upload results cannot cross A/B generations and late command acceptance preserves newly typed text', async () => {
  const { drafts, composer } = controls(); await drafts.open('A');
  const token = drafts.token()!; await drafts.open('B');
  expect(composer.appendPart(token, { type: 'image', fileId: 'A-image' })).toBe(false);
  drafts.update('  exact\r\nbytes  ');
  let finish!: () => void; let input: unknown; let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const sending = composer.submit('send', async value => { input = value; began(); return new Promise(resolve => { finish = () => resolve({ commandId: 'accepted' }); }); });
  await started;
  drafts.update('new draft'); finish(); await sending;
  expect(input).toMatchObject({ sessionId: 'B', text: '  exact\r\nbytes  ' });
  expect(drafts.snapshot()?.text).toBe('new draft');
});
it('attachment hashing blocks Enter in its original Session and cannot append into a later Session', async () => {
  const { drafts, tasks, capability } = controls(); await drafts.open('A'); drafts.update('A body');
  let finish!: () => void;
  const digest = new Promise<string>(resolve => { finish = () => resolve('a'.repeat(64)); });
  const uploads = new UploadController({ digest: async () => digest, store: { getUpload: async id => tasks.get(id),
    listUploads: async id => [...tasks.values()].filter(task => task.sessionId === id), putUpload: async task => { tasks.set(task.id, task); } } });
  const composer = new ComposerInputController(drafts, uploads, () => capability);
  const selecting = composer.addAttachment(new File(['data'], 'file.txt', { type: 'text/plain' }), 'file');
  expect(composer.reason('send')).toContain('正在准备');
  expect(await composer.submit('send', async () => { throw new Error('must not enqueue while hashing'); })).toMatchObject({ submitted: false });
  await drafts.open('B'); drafts.update('B body'); finish();
  const selected = await selecting;
  expect(selected).toMatchObject({ attached: false, task: { sessionId: 'A', name: 'file.txt' } });
  expect(drafts.snapshot()).toMatchObject({ sessionId: 'B', text: 'B body', contentParts: { parts: [] } });
});
it('a user-confirmed workspace reference keeps concurrent text edits and blocks sending while copying', async () => {
  const { drafts, composer } = controls(); await drafts.open('A');
  const part = { type: 'file', fileId: 'chosen-file', name: '引文 "draft".md' };
  drafts.update('original', { version: 1, parts: [part] });
  let finish!: (value: { path: string; fileId: string }) => void;
  const copying = composer.referenceAttachment(part, async () => new Promise(resolve => { finish = resolve; }));
  expect(composer.reason('send')).toContain('正在准备');
  drafts.update('edited while copying');
  const path = '.webdcc/uploads/chosen-file-引文 "draft".md';
  finish({ path, fileId: part.fileId }); expect(await copying).toBe(true);
  expect(drafts.snapshot()?.text).toBe(`edited while copying\n${JSON.stringify(path)}`);
  expect(drafts.snapshot()?.contentParts.parts).toEqual([{ type: 'text', text: `edited while copying\n${JSON.stringify(path)}` }]);
});
it('removing a file during a copy cannot reinsert it or its path into the draft', async () => {
  const { drafts, composer } = controls(); await drafts.open('A');
  const part = { type: 'file', fileId: 'removed-file' };
  drafts.update('keep this', { version: 1, parts: [part] });
  let finish!: (value: { path: string; fileId: string }) => void;
  const copying = composer.referenceAttachment(part, async () => new Promise(resolve => { finish = resolve; }));
  drafts.update('keep this', { version: 1, parts: [] });
  finish({ path: '.webdcc/uploads/removed-file.md', fileId: part.fileId });
  expect(await copying).toBe(false);
  expect(drafts.snapshot()).toMatchObject({ text: 'keep this', contentParts: { parts: [] } });
});
it('editing native text elements cannot submit stale byte spans and can explicitly prepare the edited text again', async () => {
  const { drafts, composer } = controls(); await drafts.open('A');
  drafts.update('old', { version: 1, parts: [{ type: 'text', text: 'old', elements: [{ byteRange: { start: 0, end: 3 }, placeholder: 'old' }] }] });
  drafts.update('different text'); expect(composer.reason('send')).toContain('文字元素');
  let submitted = false;
  expect(await composer.submit('send', async () => { submitted = true; return { commandId: 'unexpected' }; })).toMatchObject({ submitted: false });
  expect(submitted).toBe(false);
  drafts.update('different text', { version: 1, parts: [{ type: 'text', text: 'different text' }] });
  expect(await composer.submit('send', async input => { expect(input.text).toBe('different text'); return { commandId: 'durable' }; })).toEqual({ submitted: true });
});

it('a native input mode survives attachments, durable submission and draft clearing; an unverified mode or steer cannot be submitted', async () => {
  const { drafts, composer, capability } = controls(); await drafts.open('A');
  drafts.update('  原文  ', { version: 1, parts: [], collaborationMode: 'plan' });
  expect(composer.reason('send')).toContain('原生目录');
  capability.collaborationModes = ['plan', 'default'];
  expect(composer.reason('steer')).toContain('不能改变输入模式');
  expect(composer.appendPart(drafts.token()!, { type: 'text', text: '  原文  ' })).toBe(true);
  let submitted: unknown;
  expect(await composer.submit('send', async input => { submitted = input; return { commandId: 'mode-input' }; })).toEqual({ submitted: true });
  expect(submitted).toMatchObject({ text: '  原文  ', contentParts: { collaborationMode: 'plan', parts: [{ type: 'text', text: '  原文  ' }] } });
  expect(drafts.snapshot()?.contentParts).toEqual({ version: 1, parts: [], collaborationMode: 'plan' });
  await drafts.open('B'); expect(drafts.snapshot()?.contentParts.collaborationMode).toBeUndefined();
  await drafts.open('A'); expect(drafts.snapshot()?.contentParts.collaborationMode).toBe('plan');
});
