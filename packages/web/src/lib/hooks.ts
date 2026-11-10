import { useSyncExternalStore } from 'react';
import { store } from './store.js';

/** 订阅全局 store 的版本号 */
export function useStoreVersion(): number {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getVersion(),
  );
}
