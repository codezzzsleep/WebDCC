export interface DshSubagentTarget { sessionId: string; parentSessionId: string; childSessionId: string }
const eventName = 'wdcc:dsh-child-open';

/** Navigation is read-only. The panel still confirms current native membership. */
export function openDshSubagent(target: DshSubagentTarget): void {
  window.dispatchEvent(new CustomEvent(eventName, { detail: target }));
}

export function onDshSubagentOpen(read: (target: DshSubagentTarget) => void): () => void {
  const listener = (event: Event): void => {
    const target = (event as CustomEvent<unknown>).detail;
    if (target === null || typeof target !== 'object') return;
    const value = target as Partial<DshSubagentTarget>;
    if (typeof value.sessionId !== 'string' || value.sessionId === '' || typeof value.parentSessionId !== 'string'
      || value.parentSessionId === '' || typeof value.childSessionId !== 'string' || value.childSessionId === '') return;
    read(value as DshSubagentTarget);
  };
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}
