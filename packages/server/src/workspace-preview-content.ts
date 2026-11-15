import { parse, parseFragment, serialize, defaultTreeAdapter, type DefaultTreeAdapterMap } from 'parse5';
import postcss from 'postcss';
import { init, parse as parseImports } from 'es-module-lexer';

const rootUrl = (value: string, prefix: string): string => value.startsWith('/') && !value.startsWith('//') && !value.startsWith(prefix) ? prefix + value.slice(1) : value;

export function previewCss(source: string, prefix: string): string {
  const urls = (value: string): string => value.replace(/url\(\s*(['"]?)(\/(?!\/)[^)'"\s]+)\1\s*\)/gi,
    (_match, quote: string, path: string) => `url(${quote}${rootUrl(path, prefix)}${quote})`);
  try {
    const css = postcss.parse(source);
    css.walkDecls(declaration => { declaration.value = urls(declaration.value); });
    css.walkAtRules(rule => {
      rule.params = urls(rule.params);
      if (rule.name.toLowerCase() === 'import') rule.params = rule.params.replace(/^(['"])(\/(?!\/)[^'"]+)\1/, (_match, quote: string, path: string) => quote + rootUrl(path, prefix) + quote);
    });
    return css.toString();
  } catch { return source; } // Invalid CSS remains the browser's parsing decision.
}

export async function previewJavaScript(source: string, prefix: string): Promise<string> {
  await init;
  try {
    const [imports] = parseImports(source);
    let output = source;
    for (const item of [...imports].reverse()) {
      if (item.n === undefined || !item.n.startsWith('/') || item.n.startsWith('//')) continue;
      const value = rootUrl(item.n, prefix);
      output = output.slice(0, item.s) + (item.d === -1 ? value : JSON.stringify(value)) + output.slice(item.e);
    }
    return output;
  } catch { return source; }
}

/** The preview URL has a workspace prefix instead of an origin-wide web root.
 * Keep root-relative assets inside that prefix, including browser-created URLs.
 * No application globals or original disk bytes are changed. */
function runtime(prefix: string): string {
  return `(() => {
    const prefix = ${JSON.stringify(prefix)};
    const remap = value => {
      if (typeof value !== 'string') return value;
      if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith(prefix)) return prefix + value.slice(1);
      try { const u = new URL(value); if (u.origin === location.origin && !u.pathname.startsWith(prefix)) { u.pathname = prefix + u.pathname.slice(1); return u.href; } } catch {}
      return value;
    };
    const originalFetch = window.fetch;
    window.fetch = (input, options) => {
      if (input instanceof Request) input = new Request(remap(input.url), input);
      else input = remap(input instanceof URL ? input.href : input);
      return originalFetch.call(window, input, { ...options, credentials: 'omit' });
    };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) { return open.call(this, method, remap(String(url)), ...rest); };
    for (const [type, names] of [[HTMLImageElement,['src']], [HTMLScriptElement,['src']], [HTMLLinkElement,['href']], [HTMLAnchorElement,['href']], [HTMLSourceElement,['src']], [HTMLVideoElement,['src','poster']], [HTMLAudioElement,['src']]]) {
      for (const name of names) { const descriptor = Object.getOwnPropertyDescriptor(type.prototype, name); if (descriptor?.set) Object.defineProperty(type.prototype,name,{...descriptor,set(value){ descriptor.set.call(this,remap(value)); }}); }
    }
    const set = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name,value) { return set.call(this,name,/^(src|href|poster)$/i.test(name) ? remap(String(value)) : value); };
    window.addEventListener('error', event => {
      const resource = event.target?.src || event.target?.href || event.filename || '';
      let name = ''; let external = ''; try { const url = new URL(resource,location.href); name = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : ''; if (url.origin !== location.origin) external = url.hostname; } catch {}
      parent.postMessage({type:'webdcc-preview-error',message: name ? '无法加载页面资源：' + name : external ? '未能加载外部资源：' + external : '页面脚本执行失败'}, '*');
    }, true);
  })();`;
}

export async function previewHtml(source: string, prefix: string): Promise<string> {
  const document = parse(source);
  let head: DefaultTreeAdapterMap['element'] | undefined;
  const walk = async (node: DefaultTreeAdapterMap['node']): Promise<void> => {
    if ('tagName' in node) {
      if (node.tagName === 'head') head = node;
      for (const attribute of node.attrs) {
        if (['src', 'href', 'poster', 'action', 'data'].includes(attribute.name)) attribute.value = rootUrl(attribute.value, prefix);
        else if (attribute.name === 'srcset') attribute.value = attribute.value.replace(/(^|,\s*)(\/(?!\/)[^,\s]+)/g, (_match, before: string, path: string) => before + rootUrl(path, prefix));
        else if (attribute.name === 'style') attribute.value = previewCss(`a{${attribute.value}}`, prefix).replace(/^a\{|\}$/g, '');
      }
      if (node.tagName === 'style' || node.tagName === 'script') {
        for (const child of node.childNodes) if ('value' in child) {
          if (node.tagName === 'style') child.value = previewCss(child.value, prefix);
          else if (node.attrs.some(attribute => attribute.name === 'type' && attribute.value === 'module')) child.value = await previewJavaScript(child.value, prefix);
          else if (node.attrs.some(attribute => attribute.name === 'type' && attribute.value === 'importmap')) {
            try { child.value = JSON.stringify(JSON.parse(child.value) as unknown, (_key, value: unknown) => typeof value === 'string' ? rootUrl(value, prefix) : value); } catch { /* Retain invalid user import maps. */ }
          }
        }
      }
      if ('content' in node) await walk(node.content);
    }
    if ('childNodes' in node) for (const child of node.childNodes) await walk(child);
  };
  await walk(document);
  const bootstrap = parseFragment(`<script>${runtime(prefix)}</script>`).childNodes[0];
  if (head !== undefined && bootstrap !== undefined) {
    const first = head.childNodes[0];
    if (first) defaultTreeAdapter.insertBefore(head, bootstrap, first); else defaultTreeAdapter.appendChild(head, bootstrap);
  }
  return serialize(document);
}
