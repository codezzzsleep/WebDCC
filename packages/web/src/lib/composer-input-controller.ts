import type { DraftController, DraftContent } from './draft-controller.js';
import type { UploadController, UploadKind, UploadTask } from './upload-controller.js';

export type ComposerIntent = 'send' | 'queue' | 'steer';
export interface PreparedPart { type: string; text?: string; fileId?: string; uploadTaskId?: string; name?: string; mime?: string; sha256?: string; size?: number; elements?: unknown[]; skillId?: string; uri?: string; server?: string }
export interface ComposerInputCapabilities {
  inputModalities?: readonly ('text' | 'image' | 'audio')[];
  contentTypes: readonly string[];
  intents: readonly ComposerIntent[];
  running: boolean;
  unavailableReason?: string;
}
export interface PreparedComposerInput<Part = PreparedPart> { sessionId: string; text: string; contentParts: DraftContent<Part>; intent: ComposerIntent }
/** One guard for clicks and Enter. A submission clears only its own unchanged
 * draft, after the caller confirms durable command acceptance. */
export class ComposerInputController<Part extends PreparedPart = PreparedPart> {
  private sending = false;
  private readonly preparing = new Map<string, number>();
  constructor(readonly drafts: DraftController<Part>, readonly uploads: UploadController, private readonly capabilities: () => ComposerInputCapabilities) {}
  busy(): boolean { return this.sending; }
  reason(intent: ComposerIntent): string | undefined {
    const draft = this.drafts.snapshot(); const capabilities = this.capabilities();
    if (draft === undefined || this.drafts.loading()) return '草稿正在恢复';
    if ((this.preparing.get(draft.sessionId) ?? 0) > 0) return '附件正在准备';
    if (this.sending) return '消息正在保存';
    if (this.drafts.error() !== undefined) return this.drafts.error()!.message;
    if (capabilities.unavailableReason !== undefined) return capabilities.unavailableReason;
    if (!capabilities.intents.includes(intent)) return '当前原生会话不支持此发送方式';
    if (intent === 'send' && capabilities.running) return '当前会话正在运行，请选择加入队列或介入当前轮';
    if (intent === 'steer' && !capabilities.running) return '当前没有可介入的运行轮次';
    const attachments = draft.contentParts.parts.filter(part => part.type !== 'text');
    if (draft.text.trim() === '' && attachments.length === 0) return '请输入正文或选择附件';
    if (draft.text !== '' && !capabilities.contentTypes.includes('text')) return '当前原生输入不支持文字';
    const textParts = draft.contentParts.parts.filter(part => part.type === 'text');
    if (textParts.length === 1 && textParts[0]!.elements?.length && textParts[0]!.text !== draft.text) return '原生文字元素与编辑后的正文不一致，请重新准备';
    if (textParts.length > 1 && textParts.map(part => part.text ?? '').join('') !== draft.text) return '文字与结构化输入不一致，请重新核对';
    for (const part of draft.contentParts.parts) {
      if (!capabilities.contentTypes.includes(part.type)) return `当前原生输入不支持 ${part.type}`;
      if ((part.type === 'image' || part.type === 'audio') && !capabilities.inputModalities?.includes(part.type)) return `当前模型未声明支持 ${part.type} 输入`;
      if (part.uploadTaskId !== undefined) {
        const task = this.uploads.get(part.uploadTaskId);
        if (task?.sessionId !== draft.sessionId || task.kind !== part.type) return '附件上传身份与当前草稿不匹配';
        if (task.state !== 'completed' || task.fileId === undefined) return task.error ?? '附件尚未上传完成';
      } else if (['image', 'file', 'audio'].includes(part.type) && !part.fileId) return '附件缺少已上传的文件标识';
    }
    return undefined;
  }
  async submit(intent: ComposerIntent, enqueue: (input: PreparedComposerInput<Part>) => Promise<{ commandId: string }>): Promise<{ submitted: boolean; reason?: string }> {
    const reason = this.reason(intent); if (reason !== undefined) return { submitted: false, reason };
    const draft = this.drafts.snapshot()!; const token = this.drafts.token()!;
    const parts = draft.contentParts.parts.map(part => {
      const { uploadTaskId, ...selected } = part;
      return uploadTaskId === undefined ? part : { ...selected, fileId: this.uploads.get(uploadTaskId)!.fileId } as Part;
    });
    const textParts = parts.filter(part => part.type === 'text');
    // The visible textarea is declared input, so encode that exact string as
    // its text block. No instruction or textual stand-in for an asset is added.
    if (textParts.length === 0 && draft.text !== '') parts.unshift({ type: 'text', text: draft.text } as Part);
    if (textParts.length === 1) parts[parts.indexOf(textParts[0]!)] = { ...textParts[0]!, text: draft.text };
    const contentParts: DraftContent<Part> = { version: 1, parts };
    this.sending = true;
    try {
      await this.drafts.flush(token.sessionId);
      // Scope may switch while IndexedDB writes finish. Never enqueue the
      // old draft through a callback now bound to a different Session.
      if (!this.drafts.accepts(token)) return { submitted: false, reason: '会话已切换，正文仍在原草稿中' };
      const receipt = await enqueue({ sessionId: token.sessionId, text: draft.text, contentParts, intent });
      if (!receipt.commandId) throw new Error('消息没有获得持久命令标识');
      this.drafts.clearIfUnchanged(token);
      return { submitted: true };
    } finally { this.sending = false; }
  }
  /** Attach to current text, never the text captured when upload began. A
   * task already belongs to its durable original Session even when hidden. */
  appendPart(token: { sessionId: string; generation: number }, part: Part): boolean {
    if (!this.drafts.accepts(token) || this.drafts.loading()) return false;
    const current = this.drafts.snapshot()!;
    this.drafts.update(current.text, { version: 1, parts: [...current.contentParts.parts, structuredClone(part)] });
    return true;
  }
  async addAttachment(file: File, kind: UploadKind): Promise<{ attached: boolean; task: UploadTask }> {
    const token = this.drafts.token(); if (token === undefined || this.drafts.loading()) throw new Error('草稿正在恢复');
    this.preparing.set(token.sessionId, (this.preparing.get(token.sessionId) ?? 0) + 1);
    try {
      const task = await this.uploads.create(token.sessionId, file, kind);
      const attached = this.appendPart(token, { type: kind, uploadTaskId: task.id, name: task.name, mime: task.mime, sha256: task.sha256, size: task.size } as Part);
      if (attached) await this.drafts.flush(token.sessionId);
      return { attached, task };
    } finally { this.preparing.set(token.sessionId, Math.max(0, (this.preparing.get(token.sessionId) ?? 1) - 1)); }
  }
}
