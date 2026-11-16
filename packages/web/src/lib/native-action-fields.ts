import type { NativeActionRequest } from '@webdcc/protocol';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Fill hidden native fields from the current form/catalog without changing user values. */
export function nativeActionFields(action: NativeActionRequest['action'], schema: unknown, catalog: unknown, commandId: string): NativeActionRequest['action'] {
  const result = { ...action };
  const properties = object(object(schema)['properties']);
  for (const [name, definition] of Object.entries(properties)) {
    if (object(definition)['generated'] === 'commandId' && result[name] === undefined) result[name] = commandId;
  }
  if (action.type === 'settings-mutate' && object(properties['expectedRevision'])['entitySource'] === 'settings.revision') {
    const settings = object(object(catalog)['settings']);
    const matches = Array.isArray(settings['namespaces']) ? settings['namespaces'].map(object).filter(namespace => namespace['ns'] === result['ns']) : [];
    const revision = matches[0]?.['revision'];
    if (typeof result['ns'] !== 'string' || settings['unavailable'] === true || settings['writable'] !== true || matches.length !== 1
      || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('原生设置版本未确认或不可写，请刷新后重试');
    if (result['expectedRevision'] !== undefined && result['expectedRevision'] !== revision) throw new Error('原生设置版本已变化，请刷新后重试');
    result['expectedRevision'] = revision;
  }
  return result;
}
