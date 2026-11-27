import type { DraftController, DraftContent } from './draft-controller.js';
import type { UploadController, UploadKind, UploadTask } from './upload-controller.js';

export type ComposerIntent = 'send' | 'queue' | 'steer';
export interface PreparedPart { type: string; text?: string; fileId?: string; uploadTaskId?: string; name?: string; mime?: string; sha256?: string; size?: number; elements?: unknown[]; skillId?: string; uri?: string; server?: string }
export interface ComposerInputCapabilities {
  collaborationModes?: readonly ('default' | 'plan')[];
  inputModalities?: readonly ('text' | 'image' | 'audio')[];
  contentTypes: readonly string[];
  intents: readonly ComposerIntent[];
  running: boolean;
  unavailableReason?: string;
  workspaceFileReferences?: boolean;
}
export interface PreparedComposerInput<Part = PreparedPart> { sessionId: string; text: string; contentParts: DraftContent<Part>; intent: ComposerIntent }
/** One guard for clicks and Enter. A submission clears only its own unchanged
 * draft, after the caller confirms durable command acceptance. */
export class ComposerInputController<Part extends PreparedPart = PreparedPart> {
  private sending = false;
  private readonly preparing = new Map<string, number>();
  constructor(readonly drafts: DraftController<Part>, readonly uploads: UploadController, private readonly capabilities: () => ComposerInputCapabilities) {}
  busy(): boolean { return this.sending; }
  commandReason(): string | undefined {
    const draft = this.drafts.snapshot();
    if (!draft || this.drafts.loading()) return '草稿正在恢复';
    if (this.sending || (this.preparing.get(draft.sessionId) ?? 0) > 0) return '正文或附件正在准备';
    if (this.drafts.error()) return this.drafts.error()!.message;
    try { this.prepareContent(); } catch (error) { return error instanceof Error ? error.message : String(error); }
    return draft.text.trim() === '' ? '请输入原生指令' : undefined;
  }
  reason(intent: ComposerIntent): string | undefined {
    const draft = this.drafts.snapshot(); const capabilities = this.capabilities();
    if (draft === undefined || this.drafts.loading()) return '草稿正在恢复';
    if ((this.preparing.get(draft.sessionId) ?? 0) > 0) return '附件正在准备';
    if (this.sending) return '消息正在保存';
    if (this.drafts.error() !== undefined) return this.drafts.error()!.message;
    if (capabilities.unavailableReason !== undefined) return capabilities.unavailableReason;
    if (draft.contentParts.collaborationMode !== undefined && !capabilities.collaborationModes?.includes(draft.contentParts.collaborationMode)) return '所选输入模式尚未取得原生目录确认，请选择沿用原生或重新读取模式';
    if (intent === 'steer' && draft.contentParts.collaborationMode !== undefined) return '介入当前轮次不能改变输入模式';
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
      if (part.type === 'file' && capabilities.workspaceFileReferences) return '文件尚未准备完成';
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
    const contentParts = this.prepareContent();
    this.sending = true;
    try {
      await this.drafts.flush(token.sessionId);
      // Scope may switch while IndexedDB writes finish. Never enqueue the
      // old draft through a callback now bound to a different Session.
      if (!this.drafts.accepts(token)) return { submitted: false, reason: '会话已切换，正文仍在原草稿中' };
      const receipt = await enqueue({ sessionId: token.sessionId, text: draft.text, contentParts, intent });
      if (!receipt.commandId) throw new Error('消息没有获得持久命令标识');
      if (this.drafts.clearIfUnchanged(token)) await this.drafts.flush(token.sessionId);
      return { submitted: true };
    } finally { this.sending = false; }
  }
  /** Resolve the same durable attachment references for a native command,
   * whose admission rules are independent of the selected model's modalities. */
  prepareContent(): DraftContent<Part> {
    const draft = this.drafts.snapshot(); if (!draft || this.drafts.loading()) throw new Error('草稿正在恢复');
    const parts = draft.contentParts.parts.map(part => {
      const { uploadTaskId, ...selected } = part;
      if (uploadTaskId === undefined) return part;
      const task = this.uploads.get(uploadTaskId);
      if (task?.state !== 'completed' || !task.fileId || task.sessionId !== draft.sessionId) throw new Error('附件尚未上传完成，原生指令未发送');
      return { ...selected, fileId: task.fileId } as Part;
    });
    const textParts = parts.filter(part => part.type === 'text');
    if (textParts.some(part => part.elements?.length && part.text !== draft.text)) throw new Error('正文与原生文字元素不一致，请重新准备');
    if (textParts.length === 0 && draft.text !== '') parts.unshift({ type: 'text', text: draft.text } as Part);
    if (textParts.length === 1) parts[parts.indexOf(textParts[0]!)] = { ...textParts[0]!, text: draft.text };
    return { ...draft.contentParts, version: 1, parts };
  }
  /** Attach to current text, never the text captured when upload began. A
   * task already belongs to its durable original Session even when hidden. */
  appendPart(token: { sessionId: string; generation: number }, part: Part): boolean {
    if (!this.drafts.accepts(token) || this.drafts.loading()) return false;
    const current = this.drafts.snapshot()!;
    this.drafts.update(current.text, { ...current.contentParts, version: 1, parts: [...current.contentParts.parts, structuredClone(part)] });
    return true;
  }
  /** A user-confirmed workspace copy becomes a visible, editable path in the
   * body. It never impersonates a native file/mention input or adds prose. */
  async referenceAttachment(part: Part, copy: (fileId: string) => Promise<{ path: string; fileId: string }>): Promise<boolean> {
    const token = this.drafts.token();
    if (!token || this.drafts.loading() || this.sending || (this.preparing.get(token.sessionId) ?? 0) > 0) throw new Error('正文或附件正在准备，请稍候');
    const matches = (candidate: Part) => candidate.type === 'file' && (part.uploadTaskId === undefined
      ? candidate.uploadTaskId === undefined && candidate.fileId === part.fileId
      : candidate.uploadTaskId === part.uploadTaskId);
    const current = this.drafts.snapshot()!;
    if (part.type !== 'file' || !current.contentParts.parts.some(matches)) throw new Error('附件已移除，请重新选择');
    const task = part.uploadTaskId === undefined ? undefined : this.uploads.get(part.uploadTaskId);
    const fileId = task?.fileId ?? part.fileId;
    if (!fileId || part.uploadTaskId !== undefined && (task?.state !== 'completed' || task.sessionId !== token.sessionId)) throw new Error('附件尚未上传完成');
    const checkText = (parts: Part[]) => {
      if (parts.some(part => part.type === 'text' && part.elements?.length)) throw new Error('正文包含原生文字元素，请先按当前正文重新准备');
    };
    checkText(current.contentParts.parts);
    this.preparing.set(token.sessionId, (this.preparing.get(token.sessionId) ?? 0) + 1);
    try {
      const copied = await copy(fileId);
      if (copied.fileId !== fileId || !copied.path.startsWith('.webdcc/uploads/') || [...copied.path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('工作区文件引用无效，请核对后重试');
      if (!this.drafts.accepts(token) || this.drafts.loading()) return false;
      const draft = this.drafts.snapshot()!;
      if (!draft.contentParts.parts.some(matches)) return false;
      checkText(draft.contentParts.parts);
      const text = `${draft.text}${draft.text === '' || draft.text.endsWith('\n') ? '' : '\n'}${JSON.stringify(copied.path)}`;
      this.drafts.update(text, { ...draft.contentParts, parts: [
        { type: 'text', text } as Part, ...draft.contentParts.parts.filter(part => part.type !== 'text' && !matches(part)),
      ] });
      await this.drafts.flush(token.sessionId);
      return true;
    } finally { this.preparing.set(token.sessionId, Math.max(0, (this.preparing.get(token.sessionId) ?? 1) - 1)); }
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
