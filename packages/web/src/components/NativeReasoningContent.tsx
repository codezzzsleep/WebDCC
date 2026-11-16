import { nativeReasoningContent } from '@webdcc/protocol';

export function NativeReasoningContent({ item }: { item: { kind: string; data?: unknown; native?: unknown } }) {
  const parts = nativeReasoningContent(item);
  if (parts.length === 0) return null;
  const data = item.data as { incomplete?: boolean } | undefined;
  return <details data-testid="native-reasoning-content">
    <summary>原生思考正文</summary>
    {data?.incomplete ? <p>原生正文未取得完整终稿</p> : null}
    {parts.map(part => <pre className="output" key={part.index} data-testid="native-reasoning-part" data-native-index={part.index} data-raw-text={part.text}>{part.text}</pre>)}
  </details>;
}
