import type { EventData } from '@webdcc/protocol';
import { codexNativeToolStatus, codexNativeToolStatusLabel, codexNativeImageStatus } from '@webdcc/protocol';
import { store } from '../lib/store.js';

export function CodexNativeToolStatus({ sessionId, data }: { sessionId: string; data: EventData['tool.call'] }): React.ReactElement | null {
  if (store.getSession(sessionId)?.agent !== 'codex') return null;
  const status = codexNativeImageStatus(data) ?? codexNativeToolStatus(data);
  if (status === undefined) return null;
  const input = data.input as Record<string, unknown>;
  const prefix = data.name === 'mcpToolCall' ? input['server'] : input['namespace'];
  const tool = typeof input['tool'] === 'string' ? input['tool'] : data.name;
  return <p className="muted" role="status" data-testid="codex-native-tool-status"
    data-native-call-id={typeof input['id'] === 'string' ? input['id'] : undefined} data-native-tool-type={data.name}>
    原生 {typeof prefix === 'string' && prefix !== '' ? prefix + '.' : ''}{tool} 调用 · {codexNativeToolStatusLabel(status)}
  </p>;
}
