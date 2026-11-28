import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Keep keyboard input on the active modal, then return to its opening control. */
export function useModalFocus(ref: RefObject<HTMLElement | null>, close: () => void, enabled = true): void {
  const onClose = useRef(close); onClose.current = close;
  const trigger = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  if (enabled && !wasOpen.current) trigger.current = document.activeElement;
  wasOpen.current = enabled;
  useLayoutEffect(() => {
    if (!enabled) return;
    const dialog = ref.current;
    if (!dialog) return;
    const previous = trigger.current;
    const entries = (): HTMLElement[] => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]')]
      .filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
    const frame = requestAnimationFrame(() => { if (!dialog.contains(document.activeElement)) (entries()[0] ?? dialog).focus(); });
    const keydown = (event: KeyboardEvent): void => {
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].filter(element => element.getClientRects().length > 0);
      if (dialogs.at(-1) !== dialog) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose.current(); return; }
      if (event.key !== 'Tab') return;
      const all = entries(), first = all[0], last = all.at(-1);
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (!dialog.contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      cancelAnimationFrame(frame); document.removeEventListener('keydown', keydown, true);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [enabled, ref]);
}
