import type { SessionReferenceResponse } from '@webdcc/protocol';
import { agentText } from './agents.js';

export const sessionLink = (origin: string, sessionId: string): string => `${origin}/s/${encodeURIComponent(sessionId)}`;
export const codexDeepLink = (nativeId: string): string => `codex://threads/${encodeURIComponent(nativeId)}`;

export function sessionReferenceText(origin: string, reference: SessionReferenceResponse): string {
  return ['请先读取以下会话记录，再继续处理。',
    `会话：${JSON.stringify(reference.title)}`, `Agent：${agentText(reference.agent).name}`,
    `原生 Session ID：${reference.nativeId ?? '尚未建立'}`, `WebDCC 会话 ID：${reference.sessionId}`,
    `工作区：${JSON.stringify(reference.workspace.path)}`, `会话链接：${sessionLink(origin, reference.sessionId)}`,
    ...(reference.agent === 'codex' && reference.nativeId ? [`Codex Deep Link：${codexDeepLink(reference.nativeId)}`] : []),
    `记录文件：${JSON.stringify(reference.absolutePath)}`, `文件 SHA-256：${reference.sha256}`,
    `快照范围：WebDCC 已保存记录，截至序号 ${reference.throughSeq}，共 ${reference.eventCount} 个保存事件。`,
    '请用你的文件读取工具查阅记录文件；它位于上述服务器工作区。',
  ].join('\n');
}
