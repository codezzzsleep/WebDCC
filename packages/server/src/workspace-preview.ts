import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { workspaceAsset } from './workspace-assets.js';
import { rasterMime } from './file-response.js';
import { MAX_EDIT_BYTES } from './workspace-files.js';
import { previewCss, previewHtml, previewJavaScript } from './workspace-preview-content.js';
import { openWorkspaceRead } from './workspace-read.js';

const TTL = 30 * 60 * 1000;
const MAX_BYTES = 32 * 1024 * 1024;
const textTypes: Record<string, string> = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.md': 'text/plain' };
const binaryTypes: Record<string, string> = { '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
interface Grant { workspaceId: string; root: string; origin: string; entry: string; expiresAt: number; content?: string; external: boolean }
const failure = (statusCode: number, message: string): Error => Object.assign(new Error(message), { statusCode });

async function read(rootPath: string, target: string): Promise<Buffer> {
  const file = await openWorkspaceRead(rootPath, target);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw failure(400, '预览需要普通文件');
    if (info.size > MAX_BYTES) throw failure(413, '文件超过页面预览上限，请直接下载');
    const chunks: Buffer[] = []; let size = 0;
    while (size <= MAX_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_BYTES + 1 - size));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, size);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead)); size += bytesRead;
    }
    if (size > MAX_BYTES) throw failure(413, '文件超过页面预览上限，请直接下载');
    return Buffer.concat(chunks, size);
  } finally { await file.close(); }
}

/** Only the authenticated app can create a short-lived preview. Its opaque
 * sandbox has a read capability for this workspace, never an app session cookie. */
export function registerWorkspacePreview(app: FastifyInstance, store: Store): void {
  const grants = new Map<string, Grant>();
  app.addHook('onClose', async () => { grants.clear(); });
  app.post('/api/workspaces/:id/preview', { bodyLimit: 6 * MAX_EDIT_BYTES + 4096 }, async request => {
    const workspaceId = (request.params as { id: string }).id;
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace) throw failure(404, '工作区不存在');
    const body = request.body as { path?: unknown; content?: unknown; external?: unknown };
    if (typeof body?.path !== 'string' || !['.html', '.htm'].includes(extname(body.path).toLowerCase())) throw failure(400, '请选择 HTML 文件预览');
    if (body.content !== undefined && (typeof body.content !== 'string' || Buffer.byteLength(body.content) > MAX_EDIT_BYTES)) throw failure(413, '未保存的预览内容超过 1 MiB');
    if (body.external !== undefined && typeof body.external !== 'boolean') throw failure(400, '页面联网选项无效');
    const root = await realpath(workspace.path);
    const target = await workspaceAsset(root, body.path).catch(() => { throw failure(404, '预览文件不存在或不在工作区内'); });
    await read(workspace.path, target);
    for (const [key, value] of grants) if (value.expiresAt <= Date.now()) grants.delete(key);
    if (grants.size >= 256) grants.delete(grants.keys().next().value!);
    const ticket = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + TTL;
    grants.set(ticket, { workspaceId, root, origin: new URL(`${request.protocol}://${request.headers.host}`).origin, entry: body.path, expiresAt, external: body.external === true,
      ...(typeof body.content === 'string' ? { content: body.content } : {}) });
    return { url: `/workspace-preview/${ticket}/${body.path.split('/').map(encodeURIComponent).join('/')}`, expiresAt };
  });

  app.route({ method: ['GET', 'HEAD', 'OPTIONS'], url: '/workspace-preview/:ticket/*', handler: async (request, reply) => {
    const { ticket, '*': path } = request.params as { ticket: string; '*': string };
    const grant = grants.get(ticket);
    if (!grant || grant.expiresAt <= Date.now()) { grants.delete(ticket); return reply.code(403).type('text/plain').send('预览已过期，请返回文件面板重新加载'); }
    const workspace = store.getWorkspace(grant.workspaceId);
    if (!workspace || await realpath(workspace.path).catch(() => '') !== grant.root) throw failure(403, '预览工作区已变化，请重新加载');
    const prefix = `/workspace-preview/${ticket}/`;
    const source = `${grant.origin}${prefix}`;
    const network = grant.external ? ' https:' : '';
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-methods', 'GET, HEAD, OPTIONS');
    reply.header('access-control-allow-headers', 'Range');
    reply.header('content-security-policy', `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${source}${network}; style-src 'unsafe-inline' ${source}${network}; img-src data: blob: ${source}${network}; font-src data: ${source}${network}; media-src blob: ${source}${network}; connect-src ${source}${network}; frame-src ${source}; base-uri ${source}; form-action 'none'`);
    if (request.method === 'OPTIONS') return reply.code(204).send();
    const target = await workspaceAsset(grant.root, path).catch(() => { throw failure(404, '预览资源不存在或不在工作区内'); });
    let bytes = grant.content !== undefined && path === grant.entry ? Buffer.from(grant.content) : await read(workspace.path, target);
    const extension = extname(path).toLowerCase();
    const type = rasterMime(bytes) ?? textTypes[extension] ?? binaryTypes[extension];
    if (!type) throw failure(415, '此文件不支持页面预览，请直接下载');
    if (textTypes[extension] !== undefined && rasterMime(bytes) === undefined) {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw failure(415, '页面资源不是 UTF-8 文本，请直接下载'); }
      if (type === 'text/html') text = await previewHtml(text, prefix);
      else if (type === 'text/css') text = previewCss(text, prefix);
      else if (type === 'text/javascript') text = await previewJavaScript(text, prefix);
      bytes = Buffer.from(text);
    }
    const textual = type.startsWith('text/') || type === 'application/json' || type === 'image/svg+xml';
    return reply.type(type + (textual ? '; charset=utf-8' : '')).header('content-length', bytes.length).send(bytes);
  } });
}
