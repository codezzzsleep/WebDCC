import type { ThreadItem } from '../../src/schema/v2/ThreadItem.js';

export type NativeToolType = 'mcpToolCall' | 'dynamicToolCall';
export type NativeToolItem = Extract<ThreadItem, { type: NativeToolType }>;
export function nativeToolItem(type: NativeToolType, status: 'inProgress' | 'completed' | 'failed'): NativeToolItem {
  const id = type + ':original:string:call';
  const argumentsValue = { prompt: '原参数\r\n🐈', nested: { present: null } };
  return type === 'mcpToolCall' ? {
    type, id, server: 'native-reference', tool: 'reference-tool', status, arguments: argumentsValue,
    appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: null,
    result: status === 'completed' ? { content: [{ type: 'text', text: '完整原生结果\r\n🐈' }],
      structuredContent: { value: 42, nullable: null }, _meta: { source: 'controlled' } } : null,
    error: status === 'failed' ? { message: '原生工具错误\n😺' } : null, durationMs: status === 'inProgress' ? null : 27,
  } : {
    type, id, namespace: 'native.namespace', tool: 'reference-tool', status, arguments: argumentsValue,
    contentItems: status === 'completed' ? [{ type: 'inputText', text: '完整动态工具结果\r\n🐈' }] : null,
    success: status === 'inProgress' ? null : status === 'completed', durationMs: status === 'inProgress' ? null : 27,
  };
}
