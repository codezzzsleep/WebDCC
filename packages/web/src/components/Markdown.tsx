import { Children, createContext, isValidElement, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { workspaceFileUrl, isImageUrl } from '../lib/workspace-url.js';
import { ImagePreview } from './ImagePreview.js';
export const MarkdownWorkspace = createContext<string | undefined>(undefined);

type Highlighter = {
  codeToHtml: (code: string, options: { lang: string; theme: string }) => string;
};

let highlighterPromise: Promise<Highlighter> | null = null;
const remarkPlugins = [remarkGfm];

function getHighlighter(): Promise<Highlighter> | null {
  if (highlighterPromise === null) {
    highlighterPromise = import('shiki/bundle/web')
      .then((shiki) =>
        shiki.createHighlighter({
          themes: ['github-light', 'github-dark'],
          langs: ['ts', 'tsx', 'js', 'json', 'bash', 'shell', 'markdown', 'python', 'css', 'html', 'yaml'],
        }),
      )
      .then((highlighter) => ({ codeToHtml: (code, options) => highlighter.codeToHtml(code, options) }) as Highlighter)
      .catch(() => null as unknown as Highlighter);
  }
  return highlighterPromise;
}

function CodeBlock({ code, language }: { code: string; language: string }): React.ReactElement {
  const [html, setHtml] = useState<string | null>(null);
  const highlighted = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<'github-light' | 'github-dark'>(() => currentCodeTheme());
  useEffect(() => {
    const update = (): void => setTheme(currentCodeTheme());
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
    window.addEventListener('wdcc-theme-change', update);
    return () => {
      media.removeEventListener('change', update);
      window.removeEventListener('wdcc-theme-change', update);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (language === '') { setHtml(null); return undefined; }
    const highlighter = getHighlighter();
    if (highlighter === null) return undefined;
    void highlighter.then((instance) => {
      if (cancelled || instance?.codeToHtml === undefined) return;
      try {
        setHtml(instance.codeToHtml(code, { lang: language === '' ? 'text' : language, theme }));
      } catch {
        setHtml(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, language, theme]);
  useEffect(() => {
    const pre = highlighted.current?.querySelector('pre');
    if (pre) { pre.tabIndex = 0; pre.setAttribute('aria-label', '代码块'); }
  }, [html]);

  if (html !== null) return <div ref={highlighted} className="code-block" dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <pre className="code-block" tabIndex={0} aria-label="代码块">
      <code>{code}</code>
    </pre>
  );
}

function currentCodeTheme(): 'github-light' | 'github-dark' {
  const manual = document.documentElement.dataset.theme;
  const dark = manual === 'dark' || (manual !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  return dark ? 'github-dark' : 'github-light';
}

// Keep these component identities stable. Recreating the code renderer on
// every Markdown render remounts CodeBlock, resets its async Shiki state to
// <pre>, and can form a render/measure loop with the virtualized timeline.
const markdownComponents: Components = {
  pre({ children }) {
    const child = Children.toArray(children).find(isValidElement);
    if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return <pre className="code-block" tabIndex={0} aria-label="代码块">{children}</pre>;
    const language = /language-(\S+)/.exec(child.props.className ?? '')?.[1] ?? '';
    return <CodeBlock code={String(child.props.children).replace(/\n$/, '')} language={language} />;
  },
  code({ children }) {
    return <code className="inline-code">{children}</code>;
  },
  a({ href, children }) {
    const workspaceId = useContext(MarkdownWorkspace);
    const target = workspaceFileUrl(href, workspaceId, window.location.origin);
    return (
      <>
      <a href={target} target="_blank" rel="noreferrer">
        {children}
      </a>
      {href !== undefined && target !== undefined && target.startsWith('/api/workspaces/') && isImageUrl(href) ? <ImagePreview src={target} alt="工作区图片" /> : null}
      </>
    );
  },
  img({ src, alt }) {
    const workspaceId = useContext(MarkdownWorkspace);
    const target = workspaceFileUrl(src, workspaceId, window.location.origin);
    return target === undefined ? null : <ImagePreview src={target} alt={alt ?? '图片'} />;
  },
};

export function Markdown({ text }: { text: string }): React.ReactElement {
  const workspaceId = useContext(MarkdownWorkspace);
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents} urlTransform={url => defaultUrlTransform(workspaceFileUrl(url, workspaceId, window.location.origin) ?? '')}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
