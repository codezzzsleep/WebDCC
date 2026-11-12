import { useEffect, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
    const highlighter = getHighlighter();
    if (highlighter === null) return undefined;
    void highlighter.then((instance) => {
      if (cancelled || instance.codeToHtml === undefined) return;
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

  if (html !== null) return <div className="code-block" dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <pre className="code-block">
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
  code({ className, children }) {
    const match = /language-(\w+)/.exec(className ?? '');
    const content = String(children).replace(/\n$/, '');
    if (match !== null) return <CodeBlock code={content} language={match[1] ?? ''} />;
    return <code className="inline-code">{content}</code>;
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
};

export function Markdown({ text }: { text: string }): React.ReactElement {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
