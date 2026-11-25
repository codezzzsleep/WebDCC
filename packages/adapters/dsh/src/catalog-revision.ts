const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Schemastery.toJSON encodes nodes through allocator UIDs. Rename only the
 * exported schema edges (inner/sKey/list/dict); metadata and constants remain
 * literal, even when a number happens to equal a UID. Preserve unresolved or
 * extra nodes conservatively instead of dropping native schema information. */
export function canonicalDshSchema(value: unknown): unknown {
  const schema = object(value); const refs = object(schema?.['refs']);
  if (schema === undefined || refs === undefined || !Number.isSafeInteger(schema['uid']) || Object.keys(refs).length > 4096) return value;
  const ids = new Map<number, number>(); const nodes = new Map<number, Record<string, unknown>>();
  const visit = (uid: unknown): number => {
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 0 || !Object.hasOwn(refs, String(uid))) throw new Error('Unresolved native schema reference');
    const previous = ids.get(uid); if (previous !== undefined) return previous;
    const node = object(refs[String(uid)]); if (node === undefined) throw new Error('Invalid native schema node');
    const id = ids.size; ids.set(uid, id);
    const result = { ...node };
    for (const key of ['inner', 'sKey']) if (Object.hasOwn(node, key)) result[key] = visit(node[key]);
    if (Object.hasOwn(node, 'list')) {
      if (!Array.isArray(node['list'])) throw new Error('Invalid native schema list');
      result['list'] = node['list'].map(visit);
    }
    if (Object.hasOwn(node, 'dict')) {
      const dict = object(node['dict']); if (dict === undefined) throw new Error('Invalid native schema fields');
      result['dict'] = Object.fromEntries(Object.keys(dict).sort().map(key => [key, visit(dict[key])]));
    }
    nodes.set(id, result); return id;
  };
  try {
    const uid = visit(schema['uid']);
    if (nodes.size !== Object.keys(refs).length) return value;
    return { ...schema, uid, refs: Object.fromEntries([...nodes].sort(([a], [b]) => a - b).map(([id, node]) => [String(id), node])) };
  } catch { return value; }
}

export function dshCatalogForRevision(value: unknown): unknown {
  const catalog = object(value); const settings = object(catalog?.['settings']);
  if (catalog === undefined || settings === undefined || !Array.isArray(settings['namespaces'])) return value;
  return { ...catalog, settings: { ...settings, namespaces: settings['namespaces'].map(value => {
    const namespace = object(value);
    return namespace === undefined || !Object.hasOwn(namespace, 'schema') ? value : { ...namespace, schema: canonicalDshSchema(namespace['schema']) };
  }) } };
}
import { createHash } from 'node:crypto';


export function dshCatalogFingerprint(value: unknown): string {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : object(value) === undefined ? value : Object.fromEntries(Object.keys(value as object).sort().map(key => [key, ordered((value as Record<string, unknown>)[key])]));
  return createHash('sha256').update(JSON.stringify(ordered(dshCatalogForRevision(value)))).digest('hex');
}
