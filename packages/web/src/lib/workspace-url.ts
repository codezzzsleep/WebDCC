/** Local paths are resolved by the authenticated workspace endpoint. */
export function workspaceFileUrl(value: string | undefined, workspaceId: string | undefined, origin: string): string | undefined {
  if (value === undefined || workspaceId === undefined || value.startsWith('#')) return value;
  let path = value;
  if (value.startsWith('file://')) { try { path = decodeURIComponent(new URL(value).pathname); } catch { return undefined; } }
  else if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.origin !== origin || !/^\/(root|home|tmp|opt|workspace|workspaces)\//.test(url.pathname)) return value;
    path = decodeURIComponent(url.pathname);
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value)) return value;
  if (/^\/(api|files|assets|s)(?:\/|$)/.test(path)) return value;
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/raw?path=${encodeURIComponent(path)}`;
}
export function isImageUrl(value: string): boolean { return /\.(png|jpe?g|gif|webp|avif|bmp|ico)(?:[?#]|$)/i.test(value); }
