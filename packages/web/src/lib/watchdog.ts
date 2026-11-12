import { useCallback, useEffect, useState } from 'react';
import type { WatchdogJob, WatchdogView } from '@webdcc/protocol';
import { api } from './api.js';

export const watchdogStatus: Record<WatchdogJob['status'], string> = {
  scheduled: '等待恢复', recovering: '正在恢复', recovered: '恢复完成',
  'handed-off': '已交接', cancelled: '已取消', exhausted: '需要手动处理',
};

export function useWatchdog(): { view: WatchdogView | null; error: string | null; refresh: () => Promise<void>; setView: (view: WatchdogView) => void } {
  const [view, setView] = useState<WatchdogView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setView(await api.watchdog()); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  return { view, error, refresh, setView };
}
