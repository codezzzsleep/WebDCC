import type { EventData } from '@webdcc/protocol';

export type DshSystemSections = NonNullable<EventData['internal']['dshSystemSections']>;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Mirror the published systemSections fold for observation only. Notices are
 * preserved in the raw message; only canonical contentIndex text is effective.
 * Nothing here supplies or changes the native model's prompt. */
export class DshSystemMessages {
  private state: DshSystemSections;
  constructor(format: DshSystemSections['format']) {
    this.state = { format, sections: [], complete: false, needsRebuild: false };
  }
  snapshot(): DshSystemSections { return structuredClone(this.state); }
  accept(type: string, value: unknown): DshSystemSections {
    if (type === 'compaction/summary') { this.state.needsRebuild = true; return this.snapshot(); }
    if (type !== 'system/message') return this.snapshot();
    const message = object(object(value)['message']);
    const source = object(message['source']);
    const content = message['content'];
    if (this.state.format === 'whole') {
      const text = Array.isArray(content) ? content.flatMap(raw => {
        const part = object(raw); return part['type'] === 'text' && typeof part['text'] === 'string' ? [part['text']] : [];
      }).join('\n') : '';
      this.state = { format: 'whole', sections: [{ name: 'legacy-whole-prompt', order: 0, text }], complete: false, needsRebuild: false };
      return this.snapshot();
    }
    const invalid = () => { this.state = { format: 'sections', sections: [], complete: false, needsRebuild: true }; return this.snapshot(); };
    if (!Array.isArray(content) || source['kind'] !== 'system-prompt' || !Array.isArray(source['sections'])
      || source['reset'] !== undefined && source['reset'] !== true || source['complete'] !== undefined && source['complete'] !== true) return invalid();
    const seen = new Set<string>(); const indexes = new Set<number>();
    const changes: ({ name: string; retired: true } | { name: string; retired: false; order: number; text: string })[] = [];
    for (const raw of source['sections']) {
      const section = object(raw); const name = section['name'];
      if (typeof name !== 'string' || seen.has(name)) return invalid();
      seen.add(name);
      const attributed = [...(section['contentIndex'] === undefined ? [] : [section['contentIndex']]), ...(Array.isArray(section['noticeIndex']) ? section['noticeIndex'] : [])];
      if (section['noticeIndex'] !== undefined && !Array.isArray(section['noticeIndex'])) return invalid();
      for (const index of attributed) {
        if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= content.length || indexes.has(Number(index))) return invalid();
        indexes.add(Number(index));
      }
      if (section['state'] === 'retired') {
        if (section['contentIndex'] !== undefined) return invalid();
        changes.push({ name, retired: true });
      } else {
        const part = object(content[Number(section['contentIndex'])]);
        if (section['state'] !== 'active' || !Number.isFinite(section['order']) || !Number.isSafeInteger(section['contentIndex']) || part['type'] !== 'text' || typeof part['text'] !== 'string') return invalid();
        changes.push({ name, retired: false, order: Number(section['order']), text: part['text'] });
      }
    }
    if (source['reset'] !== true && changes.length === 0) return this.snapshot();
    const sections = new Map((source['reset'] === true ? [] : this.state.sections).map(section => [section.name, section]));
    for (const change of changes) {
      if (change.retired) sections.delete(change.name);
      else sections.set(change.name, { name: change.name, order: change.order, text: change.text });
    }
    this.state = { format: 'sections', sections: [...sections.values()], complete: source['complete'] === true,
      needsRebuild: source['reset'] === true ? false : this.state.needsRebuild };
    return this.snapshot();
  }
  baseline(value: unknown): void {
    const state = object(value);
    if (this.state.format !== 'sections' || !Array.isArray(state['sections']) || typeof state['complete'] !== 'boolean' || typeof state['needsRebuild'] !== 'boolean') return;
    const sections: DshSystemSections['sections'] = []; const seen = new Set<string>();
    for (const raw of state['sections']) {
      const section = object(raw);
      if (typeof section['name'] !== 'string' || seen.has(section['name']) || !Number.isFinite(section['order']) || typeof section['text'] !== 'string') return;
      seen.add(section['name']); sections.push({ name: section['name'], order: Number(section['order']), text: section['text'] });
    }
    this.state = { format: 'sections', sections, complete: state['complete'], needsRebuild: state['needsRebuild'] };
  }
}
