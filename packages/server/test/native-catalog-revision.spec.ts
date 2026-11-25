import { expect, it } from 'vitest';
import type { AgentAdapter } from '@webdcc/protocol';
import { dshCatalogForRevision } from '../../adapters/dsh/src/catalog-revision.js';
import { createTestApp } from './helpers.js';

it('accepts stable native settings despite reallocated schema IDs, returns the original catalog and rejects real changes', async () => {
  const ctx = await createTestApp();
  try {
    const workspace = ctx.store.createWorkspace('Stable native catalog', ctx.dataDir);
    const source = ctx.store.createSession({ workspaceId: workspace.id, agent: 'dsh' }); ctx.store.updateSession(source.id, { nativeId: 'native-source' });
    const adapter: AgentAdapter = ctx.manager.adapter('dsh')!;
    let uid = 10; let max = 5; let configRevision = 1; let host = 'host-a'; let state = 1; let controls = 0;
    adapter.nativeState = () => ({ revision: String(state), host });
    adapter.nativeCatalog = async () => ({ settings: { revision: configRevision, namespaces: [{ ns: 'native', schema: { uid: uid++, refs: { [uid - 1]: { type: 'number', meta: { max } } } } }] } });
    adapter.nativeCatalogForRevision = dshCatalogForRevision;
    adapter.executeNativeControl = async () => { controls++; return {}; };
    await ctx.manager.connectNativeControls(source.id, { commandId: 'stable-connect', action: { type: 'connect' } });
    const first = await ctx.manager.nativeControls(source.id, true); const next = await ctx.manager.nativeControls(source.id, true);
    expect(first.revision).toBe(next.revision);
    expect((first.catalog as { settings: { namespaces: { schema: { uid: number } }[] } }).settings.namespaces[0]!.schema.uid).not.toBe((next.catalog as { settings: { namespaces: { schema: { uid: number } }[] } }).settings.namespaces[0]!.schema.uid);
    const action = { type: 'rename', title: 'Actual action' };
    expect((await ctx.manager.executeNativeControl(source.id, { commandId: 'stable-action', revision: first.revision, action })).receipt.state).toBe('completed');
    expect(controls).toBe(1);
    for (const mutate of [() => { max++; }, () => { configRevision++; }, () => { host = 'host-b'; }, () => { state++; }]) {
      const before = await ctx.manager.nativeControls(source.id, true); mutate();
      await expect(ctx.manager.executeNativeControl(source.id, { commandId: `changed-${uid}`, revision: before.revision, action })).rejects.toMatchObject({ code: 'native-control-rejected' });
    }
    expect(controls).toBe(1);
  } finally { await ctx.close(); }
});
