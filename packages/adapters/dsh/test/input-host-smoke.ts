/** Real installed native storage/receipt verification. Never sends a prompt,
 * command, model request, or writes to an existing native profile. */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DshHostClient, attachToDshCredentials, startSidecar } from '../src/host.js';
import { readDshHostIdentity, requireDshBaseline } from '../src/identity.js';

const directory = await mkdtemp(join(tmpdir(), 'webdcc-dsh-attachment-'));
const workspace = join(directory, 'workspace'); await mkdir(workspace);
const home = join(directory, 'native-home');
const bytes = Buffer.concat([Buffer.from('verbatim-native-upload\r\n'), randomBytes(41)]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const reportPath = process.argv[2] ?? '.artifacts/dsh-input-native-smoke.json';
let sidecar: Awaited<ReturnType<typeof startSidecar>> | undefined;
let client: DshHostClient | undefined;
let nativeId: string | undefined;
let firstReceipt: string | undefined;
const reports: Record<string, unknown>[] = [];
let result: Record<string, unknown> = { status: 'running', modelPrompts: 0, paidCalls: 0, scope: 'installed DSH native binary upload and immutable storage across isolated Host restart' };
try {
  for (let attempt = 0; attempt < 2; attempt++) {
    sidecar = await startSidecar({ port: 0, cwd: workspace, bootTimeoutMs: 30_000,
      env: { PATH: process.env['PATH'], HOME: join(directory, 'home'), DSH_HOME: home, XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'),
        CODEX_HOME: join(directory, 'codex'), CLAUDE_CONFIG_DIR: join(directory, 'claude'), LANG: 'C.UTF-8' } });
    const endpoint = `http://127.0.0.1:${sidecar.port}/`;
    const credentials = await attachToDshCredentials(endpoint, sidecar.token);
    const identity = await readDshHostIdentity(endpoint, credentials.browserCookie); requireDshBaseline(identity);
    client = new DshHostClient(endpoint); client.useCookie(credentials.browserCookie); await client.connect();
    if (nativeId === undefined) {
      const created = await client.rpc<{ workspace: { workspaceId: string } }>('workspace/create', { request: { path: workspace } });
      nativeId = (await client.rpc<{ sessionId: string }>('session/create', { request: { workspaceId: created.workspace.workspaceId } })).sessionId;
    }
    const uploaded = await client.uploadFileBinary({ sessionId: nativeId, data: bytes, fileId: 'isolated-proof-file', name: 'proof.bin' });
    if (uploaded.file.attachmentId !== `sha256:${sha256}` || uploaded.file.bytes !== bytes.byteLength) throw new Error('Native storage identity or byte length differs');
    const persisted = await readFile(join(home, 'attachments', 'v1', 'files', sha256.slice(0, 2), sha256, uploaded.file.name));
    if (!persisted.equals(bytes)) throw new Error('Native stored file bytes differ');
    if (firstReceipt !== undefined && firstReceipt === uploaded.receiptId) throw new Error('Native restart did not mint a fresh receipt');
    firstReceipt ??= uploaded.receiptId;
    reports.push({ boot: attempt + 1, version: identity.version, nativeCommit: identity.commit, hostFingerprint: identity.fingerprint,
      nativeId, bytes: persisted.byteLength, sha256, sameStoredBytes: true, freshReceipt: attempt > 0 });
    await client.close(); client = undefined; await sidecar.stop(); sidecar = undefined;
  }
  result = { ...result, status: 'passed', boots: reports, receiptScope: 'new native Session-scoped receipt minted after Host restart; original receipt authority is not logged',
    excludes: ['model admission/generation', 'public remote reachability', 'original native profile', 'existing deployment'] };
} catch (error) {
  result = { ...result, status: 'failed', error: error instanceof Error ? error.message : 'native upload failed', boots: reports }; process.exitCode = 1;
} finally {
  await client?.close().catch(() => undefined); await sidecar?.stop().catch(() => undefined); await rm(directory, { recursive: true, force: true });
  await mkdir('.artifacts', { recursive: true });
  await writeFile(reportPath, JSON.stringify({ ...result, cleanup: { clientClosed: true, sidecarStopped: true, isolatedHomeRemoved: true } }, null, 2));
  console.log(JSON.stringify({ status: result['status'], boots: reports.length, modelPrompts: 0, report: reportPath }));
}
