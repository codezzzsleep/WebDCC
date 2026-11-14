import type { FastifyReply } from 'fastify';

/** Browser-safe raster types are identified from bytes, not upload MIME or suffix. */
export function rasterMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp' && ['avif', 'avis'].includes(bytes.subarray(8, 12).toString('ascii'))) return 'image/avif';
  if (bytes.length >= 14 && bytes.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
  if (bytes.length >= 6 && bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'image/x-icon';
  return undefined;
}

export function fileResponseHeaders(reply: FastifyReply, name: string, head: Buffer): void {
  const mime = rasterMime(head);
  reply.header('content-type', mime ?? 'application/octet-stream');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('content-security-policy', "sandbox; default-src 'none'");
  if (mime === undefined) reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(Buffer.from(name.replace(/[\r\n]/g, ''), 'utf8').toString('utf8'))}`);
}
