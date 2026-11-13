import { useState } from 'react';
export function ImagePreview({ src, alt }: { src: string; alt: string }): React.ReactElement {
  const [failed, setFailed] = useState<string | null>(null);
  return failed === src ? <span className="file-editor-error" role="status">图片加载失败 · <a href={src} target="_blank" rel="noreferrer">打开图片</a></span>
    : <a href={src} target="_blank" rel="noreferrer"><img className="workspace-image" src={src} alt={alt} loading="lazy" onError={() => setFailed(src)} /></a>;
}
