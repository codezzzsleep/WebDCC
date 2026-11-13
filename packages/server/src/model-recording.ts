import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, CreateOpts } from '@webdcc/protocol';
import { ModelProxy } from '@webdcc/model-proxy';
import { codexConfigRead } from './provider-import.js';
import type { InteractionRecorder, InteractionContext } from './interaction-recorder.js';

/** Each native process owns its route; concurrent sessions never share a
 * guessed "current session". The public Provider configuration stays intact. */
export class ModelRecording {
  private readonly proxies = new Map<string, ModelProxy>();
  private readonly addresses = new Map<string, string>();
  constructor(private readonly recorder: InteractionRecorder) {}
  async prepare(opts: CreateOpts, agent: AgentId): Promise<CreateOpts> {
    const traced = { ...opts, traceSink: this.recorder.sink(opts.sessionId) };
    if (agent === 'dsh') return traced;
    const protocol = agent === 'codex' ? 'openai-responses' : 'anthropic-messages';
    let target = opts.provider?.endpoints?.[protocol] ?? opts.provider?.baseUrl;
    let codexProvider: string | undefined;
    if (target === undefined && agent === 'codex') {
      const config = await codexConfigRead(opts.cwd);
      const id = config?.['model_provider'];
      const providers = config?.['model_providers'] as Record<string, Record<string, unknown>> | undefined;
      const provider = typeof id === 'string' ? providers?.[id] : undefined;
      // Opaque native OAuth endpoints are not guessed or re-authenticated.
      if (typeof id === 'string' && typeof provider?.['base_url'] === 'string') { target = provider['base_url']; codexProvider = id; }
    }
    if (target === undefined && agent === 'claude-code') {
      const env = { ...process.env };
      const directory = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
      for (const path of [join(directory, 'settings.json'), join(opts.cwd, '.claude', 'settings.json'), join(opts.cwd, '.claude', 'settings.local.json')]) {
        const value = await readFile(path, 'utf8').then(text => JSON.parse(text) as { env?: Record<string, string> }).catch(() => ({} as { env?: Record<string, string> }));
        Object.assign(env, value.env ?? {});
      }
      target = env['ANTHROPIC_BASE_URL'];
      this.recorder.addSecret(env['ANTHROPIC_AUTH_TOKEN']); this.recorder.addSecret(env['ANTHROPIC_API_KEY']);
    }
    if (target === undefined) { this.recorder.record(opts.sessionId, 'recording', 'model-coverage', { mode: 'native-only', reason: 'Native authentication owns an opaque endpoint' }); return traced; }
    this.recorder.addSecret(opts.provider?.apiKey);
    let proxy = this.proxies.get(opts.sessionId);
    if (proxy === undefined) {
      const owners = new Map<string, InteractionContext | undefined>();
      proxy = new ModelProxy({ target, secrets: opts.provider?.apiKey === undefined ? [] : [opts.provider.apiKey], onEvent: event => {
        if (event.phase === 'request') owners.set(event.requestId, this.recorder.context(opts.sessionId));
        this.recorder.record(opts.sessionId, 'model-http', event.phase, event, event.phase === 'request' ? 'out' : 'in', owners.get(event.requestId));
        if (event.phase === 'complete') owners.delete(event.requestId);
      } });
      const address = await proxy.listen();
      this.proxies.set(opts.sessionId, proxy);
      this.addresses.set(opts.sessionId, address.url);
      this.recorder.record(opts.sessionId, 'recording', 'model-route', { protocol, target });
      if (opts.provider !== null && opts.provider !== undefined) return { ...traced, provider: { ...opts.provider, baseUrl: address.url, endpoints: { ...opts.provider.endpoints, [protocol]: address.url } } };
      return { ...traced, recordingEndpoint: { url: address.url, ...(codexProvider === undefined ? {} : { codexProvider }) } };
    }
    const url = this.addresses.get(opts.sessionId);
    if (url === undefined) return traced;
    if (opts.provider !== null && opts.provider !== undefined) return { ...traced, provider: { ...opts.provider, baseUrl: url, endpoints: { ...opts.provider.endpoints, [protocol]: url } } };
    return { ...traced, recordingEndpoint: { url, ...(codexProvider === undefined ? {} : { codexProvider }) } };
  }
  async close(sessionId: string): Promise<void> {
    const proxy = this.proxies.get(sessionId); this.proxies.delete(sessionId);
    this.addresses.delete(sessionId);
    await proxy?.close().catch(error => this.recorder.record(sessionId, 'recording', 'error', { message: error instanceof Error ? error.message : String(error) }));
  }
}
