import { expect, it } from 'vitest';
import { payloadHash } from '../../../server/src/command-journal.js';
import { canonicalDshSchema, dshCatalogForRevision } from '../src/catalog-revision.js';

const schema = { uid: 9, refs: {
  '9': { type: 'object', meta: {}, dict: { next: 1, limit: 2, alias: 1 } },
  '1': { type: 'union', meta: {}, list: [3, 9] },
  '2': { type: 'number', meta: { default: 9, max: 4096 } },
  '3': { type: 'const', meta: {}, value: 9 },
} };
const reallocated = { uid: 509, refs: {
  '503': { type: 'const', value: 9, meta: {} },
  '502': { meta: { max: 4096, default: 9 }, type: 'number' },
  '501': { meta: {}, type: 'union', list: [503, 509] },
  '509': { type: 'object', dict: { limit: 502, alias: 501, next: 501 }, meta: {} },
} };

it('native schema graph identity ignores allocator numbers while retaining aliases, cycles, scalar defaults and ordered choices', () => {
  const original = structuredClone(schema);
  const first = payloadHash(canonicalDshSchema(schema));
  expect(payloadHash(canonicalDshSchema(reallocated))).toBe(first);
  expect(schema).toEqual(original);
  for (const change of [
    (copy: typeof reallocated) => { copy.refs['502'].meta.default = 509; },
    (copy: typeof reallocated) => { copy.refs['503'].value = 509; },
    (copy: typeof reallocated) => { copy.refs['501'].list.reverse(); },
    (copy: typeof reallocated) => { copy.refs['509'].dict.alias = 502; },
  ]) {
    const changed = structuredClone(reallocated); change(changed);
    expect(payloadHash(canonicalDshSchema(changed))).not.toBe(first);
  }
});

it('does not discard unresolved/extra native schema information or touch config values that resemble a schema', () => {
  const extra = { ...schema, refs: { ...schema.refs, '44': { type: 'unknown-future-node', value: 'retain this' } } };
  expect(canonicalDshSchema(extra)).toEqual(extra);
  const unresolved = { uid: 1, refs: { '1': { type: 'array', inner: 2 } } };
  expect(canonicalDshSchema(unresolved)).toEqual(unresolved);
  const first = { settings: { revision: 1, value: { uid: 9, refs: { '9': 'literal user configuration' } }, namespaces: [{ ns: 'native', revision: 2, schema }] }, models: ['one'] };
  const second = { ...first, settings: { ...first.settings, namespaces: [{ ns: 'native', revision: 2, schema: reallocated }] } };
  expect(payloadHash(dshCatalogForRevision(first))).toBe(payloadHash(dshCatalogForRevision(second)));
  second.settings.revision = 3;
  expect(payloadHash(dshCatalogForRevision(first))).not.toBe(payloadHash(dshCatalogForRevision(second)));
  expect((dshCatalogForRevision(first) as typeof first).settings.value).toEqual(first.settings.value);
});
