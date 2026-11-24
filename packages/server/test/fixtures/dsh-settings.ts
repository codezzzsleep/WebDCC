import { createServer } from 'node:http';

/** A local Host contract fixture; it never runs DSH or accesses user config. */
export async function settingsHost(options: { nativeVersion?: string } = {}) {
  let nativeVersion = options.nativeVersion ?? '0.2.2-rc.1';
  let manifestRevision = 'settings-fixture';
  const provider = { baseURL: 'https://fixture.example/v1', apiKeyEnv: 'FIXTURE_KEY', reasoning: 'high', models: [
    { id: 'a', name: 'Model A', reasoningEfforts: { high: 'high' }, contextWindow: 111, unknown: 'keep A' },
    { id: 'b', name: 'Model B', reasoningEfforts: { low: 'low', high: 'high' }, maxTokens: 222, unknown: 'keep B' },
  ] };
  const namespace = (ns: string, value: Record<string, unknown>) => ({ ns, value, revision: 1, autoGenerate: true, schema: {}, applies: 'live', secrets: [] as { path: string[]; set: boolean }[] });
  const state = { writable: true, hasDocument: true, namespaces: [namespace('llm-pi-ai', { providers: { target: provider, other: { baseURL: 'https://other.example', extra: 'keep other' } } }), namespace('agent-default-model', { provider: 'target', model: 'a', reasoningEffort: 'high', extra: 'keep defaults' })] };
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const credentials = new Map<string, string>([['FIXTURE_KEY', 'original fixture key'], ['OTHER_KEY', 'other fixture key']]);
  let rejectCredentials = false;
  let beforeCredentialSet: (() => Promise<void>) | undefined;
  let rejectWrites = false;
  let ignoreWrites = false;
  let beforeWrite: (() => void) | undefined;
  let normalizeWrite: ((value: Record<string, unknown>) => void) | undefined;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/dsh/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<html><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev: manifestRevision, release: { version: nativeVersion, commit: 'settings-fixture' }, entries: [] })}</script></html>`);
      return;
    }
    let text = '';
    for await (const chunk of request) text += String(chunk);
    const message = JSON.parse(text) as { rpcId: string; method: string; payload: { args: Record<string, unknown> } };
    const args = message.payload.args;
    calls.push({ method: message.method, args });
    let value: unknown;
    let failure: { code: string; message: string } | undefined;
    if (message.method === 'settings/describe') value = structuredClone(state);
    else if (message.method === 'session/modelCatalog') value = { groups: [], model: 'a', provider: 'target' };
    else if (message.method === 'credentials/describe') value = Object.fromEntries((args['refs'] as string[]).map(ref => [ref, { configured: credentials.has(ref), writable: true }]));
    else if (message.method === 'credentials/set') {
      await beforeCredentialSet?.();
      if (rejectCredentials) failure = { code: 'credentials/refused', message: String(args['value']) };
      else credentials.set(String(args['ref']), String(args['value']));
    }
    else if (message.method === 'settings/mutate') {
      const target = state.namespaces.find(entry => entry.ns === args['ns'])!;
      beforeWrite?.();
      if (rejectWrites) failure = { code: 'settings/rejected', message: 'Native write refused' };
      else if (target.revision !== args['expectedRevision']) failure = { code: 'settings/conflict', message: 'Stale native editor' };
      else {
        if (!ignoreWrites) {
          const next = structuredClone(target.value);
          for (const op of args['ops'] as { op: 'set'; path: string[]; value: unknown }[]) {
            let node = next;
            for (const part of op.path.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
            node[op.path.at(-1)!] = op.value;
          }
          normalizeWrite?.(next);
          target.value = next; target.revision++;
        }
        value = structuredClone(target);
      }
    } else failure = { code: 'unknown-method', message: message.method };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: failure === undefined ? { ok: true, value } : { ok: false, error: failure } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing fixture address');
  return { url: `http://127.0.0.1:${address.port}/dsh/`, state, calls, credentials,
    changeRuntime(version: string, revision = manifestRevision) { nativeVersion = version; manifestRevision = revision; },
    rejectCredentials(value: boolean) { rejectCredentials = value; },
    beforeCredentialSet(callback: () => Promise<void>) { beforeCredentialSet = callback; },
    rejectWrites(value: boolean) { rejectWrites = value; }, ignoreWrites(value: boolean) { ignoreWrites = value; }, beforeWrite(callback: () => void) { beforeWrite = callback; },
    normalizeWrite(callback: (value: Record<string, unknown>) => void) { normalizeWrite = callback; },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))); },
  };
}
