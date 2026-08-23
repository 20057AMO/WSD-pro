/**
 * markdown.ts
 * WSD-Pro — Shared markdown rendering for chat surfaces (Agents, project Chat).
 * marked → HTML, then whitelist-sanitized so model output can never inject markup.
 */
import { marked } from 'marked';

export function sanitizeHtml(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const ALLOWED = new Set(['P', 'BR', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'CODE', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN', 'A', 'DIV', 'KBD']);
  const ALLOWED_ATTR: Record<string, Set<string>> = { A: new Set(['href', 'title']), CODE: new Set(['class']), SPAN: new Set(['class']), TD: new Set(['align']), TH: new Set(['align']), DIV: new Set(['class']) };
  function walk(node: ChildNode): string {
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeType !== 1) return '';
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (!ALLOWED.has(tag)) return el.textContent || '';
    const allowedAttrs = ALLOWED_ATTR[tag] || new Set<string>();
    let attrs = '';
    for (const a of Array.from(el.attributes)) {
      if (allowedAttrs.has(a.name)) {
        if (tag === 'A' && a.name === 'href') {
          const v = a.value.trim().toLowerCase();
          if (v.startsWith('javascript:') || v.startsWith('data:')) continue;
        }
        attrs += ` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
      }
    }
    const inner = Array.from(el.childNodes).map(walk).join('');
    if (tag === 'HR' || tag === 'BR') return `<${tag.toLowerCase()}${attrs}/>`;
    return `<${tag.toLowerCase()}${attrs}>${inner}</${tag.toLowerCase()}>`;
  }
  return Array.from(tmp.childNodes).map(walk).join('');
}

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { gfm: true, breaks: true });
  return sanitizeHtml(typeof html === 'string' ? html : src);
}
