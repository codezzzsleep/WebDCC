import { useEffect, useState } from 'react';
import type { InputContent } from '@webdcc/protocol';
import type { PreparedPart } from '../lib/composer-input-controller.js';
import { Icon } from './Icon.js';

export function AttachmentPreview({ part, blob }: { part: PreparedPart; blob?: Blob }): React.ReactElement {
  const [localUrl, setLocalUrl] = useState<string>();
  useEffect(() => {
    if (blob === undefined) { setLocalUrl(undefined); return; }
    const url = URL.createObjectURL(blob); setLocalUrl(url); return () => URL.revokeObjectURL(url);
  }, [blob]);
  const url = part.fileId === undefined ? localUrl : `/files/${encodeURIComponent(part.fileId)}`;
  const label = part.name ?? (part.type === 'image' ? '图片' : part.type === 'audio' ? '音频' : '文件');
  if (url !== undefined && part.type === 'image') return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={label} style={{ maxWidth: 120, maxHeight: 96, objectFit: 'contain' }} /></a>;
  if (url !== undefined && part.type === 'audio') return <audio controls src={url} aria-label={label} style={{ maxWidth: 240 }} />;
  return url === undefined ? <span>{label}</span> : <a href={url} target="_blank" rel="noreferrer">{label}</a>;
}
export function InputAttachments({ contentParts, images }: { contentParts?: InputContent; images?: string[] }): React.ReactElement | null {
  const parts: PreparedPart[] = contentParts?.parts.filter(part => part.type !== 'text') ?? (images ?? []).map(fileId => ({ type: 'image', fileId }));
  if (parts.length === 0) return null;
  return <div className="attachments" data-testid="message-attachments">{parts.map((part, index) => <span className="attachment-chip" key={`${part.fileId ?? part.skillId ?? part.uri}-${index}`}>
    <Icon name={part.type === 'image' ? 'image' : 'paperclip'} size={13} /><AttachmentPreview part={part} />
  </span>)}</div>;
}
