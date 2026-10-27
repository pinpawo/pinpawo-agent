import React, { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type WikiLink = { path: string; anchor: string };

/** Resolve only links within the actual list of Wiki pages, never local machine paths. */
export function resolveWikiLink(href: string, currentPath: string, paths: readonly string[]): WikiLink | null {
  if (!href || href.startsWith('/') || href.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  try {
    const base = new URL(`/wiki/${currentPath.split('/').map(encodeURIComponent).join('/')}`, 'https://knowledge.invalid');
    const url = new URL(href, base);
    if (url.origin !== base.origin || !url.pathname.startsWith('/wiki/') || url.search) return null;
    const path = decodeURIComponent(url.pathname.slice('/wiki/'.length));
    if (!paths.includes(path)) return null;
    return { path, anchor: decodeURIComponent(url.hash.slice(1)) };
  } catch {
    return null;
  }
}

type MarkdownNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
};

function nodeText(node: MarkdownNode): string {
  return node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(nodeText).join('');
}

/** Match the familiar Markdown heading fragments, including repeated headings. */
function headingIds() {
  return (tree: MarkdownNode) => {
    const counts = new Map<string, number>();
    const visit = (node: MarkdownNode) => {
      if (node.type === 'element' && /^h[1-6]$/.test(node.tagName ?? '')) {
        const base = nodeText(node).toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
        const count = counts.get(base) ?? 0;
        counts.set(base, count + 1);
        node.properties = { ...node.properties, id: count ? `${base}-${count}` : base };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export function KnowledgeDocument({ path, content, paths, anchor, onNavigate }: {
  path: string;
  content: string;
  paths: readonly string[];
  anchor: string;
  onNavigate: (path: string, anchor: string) => void;
}) {
  const article = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!anchor) return;
    const target = Array.from(article.current?.querySelectorAll<HTMLElement>('[id]') ?? [])
      .find((element) => element.id === anchor);
    target?.scrollIntoView({ block: 'start' });
  }, [anchor, path, content]);
  return <div className="channel-message-body knowledge-markdown" ref={article}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[headingIds]} components={{
      a: ({ href = '', children }) => {
        const internal = resolveWikiLink(href, path, paths);
        if (internal) return <a href={href} onClick={(event) => {
          event.preventDefault();
          onNavigate(internal.path, internal.anchor);
          if (internal.path === path && internal.anchor === anchor && anchor) {
            Array.from(article.current?.querySelectorAll<HTMLElement>('[id]') ?? [])
              .find((element) => element.id === anchor)?.scrollIntoView({ block: 'start' });
          }
        }}>{children}</a>;
        if (/^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
        return <span title="This link points outside the available Wiki pages">{children}</span>;
      },
      img: ({ alt }) => <span>{alt}</span>,
    }}>{content}</ReactMarkdown>
  </div>;
}
