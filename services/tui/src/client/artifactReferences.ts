import { parseArtifactUri, type Deliverable } from '@pinpawo/agent-contracts';
import type { AgentMessageEntry } from '@pinpawo/agent-session';
import { Marked } from 'marked';

// Consume bare artifact URIs before Markdown interprets valid filename characters as emphasis.
const markdown = new Marked({ extensions: [{
  name: 'artifactUrl', level: 'inline',
  start: text => text.indexOf('artifact://'),
  tokenizer(text) {
    const match = /^artifact:\/\/[^\s<>"`]+/u.exec(text);
    if (!match) return;
    // URI segment encoding leaves apostrophes and exclamation marks intact.
    let uri = match[0].replace(/[.,;:?，。；：？]+$/u, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (uri.endsWith(close) && uri.split(close).length > uri.split(open).length) uri = uri.slice(0, -1);
    }
    try { parseArtifactUri(uri); } catch { return; }
    return { type: 'artifactUrl', raw: uri, uri };
  },
}] });

/** Display-only links; never infer canonical deliverables from reply prose. */
export function messageDisplayReferences(entry: Pick<AgentMessageEntry, 'text' | 'deliverables'>): Deliverable[] {
  const references = new Map((entry.deliverables ?? []).map(reference => [reference.uri, reference]));
  const add = (uri: string, title?: string) => {
    try { parseArtifactUri(uri); } catch { return; }
    if (!references.has(uri)) references.set(uri, { uri, ...(title ? { title } : {}) });
  };
  markdown.walkTokens(markdown.lexer(entry.text), token => {
    if ((token.type === 'link' || token.type === 'image') && typeof token.href === 'string') {
      add(token.href, typeof token.text === 'string' ? token.text : undefined);
    } else if (token.type === 'artifactUrl' && typeof token.uri === 'string') add(token.uri);
  });
  return [...references.values()];
}
