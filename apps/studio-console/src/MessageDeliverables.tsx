import React, { useState, type ReactNode } from 'react';
import { defaultUrlTransform } from 'react-markdown';
import type { Deliverable } from '@pinpawo/agent-session';

export type ArtifactSource = { url: string; token: string };

/** Keep the Studio token in the request header, never in a shareable link. */
export function artifactUrl(uri: string, source?: ArtifactSource): string {
  return `${source?.url ?? ''}/agent-session/artifacts?uri=${encodeURIComponent(uri)}`;
}

export function messageUrlTransform(uri: string): string {
  return uri.startsWith('artifact://') ? uri : defaultUrlTransform(uri);
}

export async function readArtifactBlob(uri: string, source: ArtifactSource): Promise<Blob> {
  const response = await fetch(artifactUrl(uri, source), {
    headers: { Authorization: `Bearer ${source.token}` },
  });
  if (!response.ok) throw new Error(`Could not download artifact (${response.status}).`);
  return response.blob();
}

export function MessageLink({ href, children, source }: { href?: string; children: ReactNode; source?: ArtifactSource }) {
  const [problem, setProblem] = useState('');
  if (!href?.startsWith('artifact://')) return <a href={defaultUrlTransform(href ?? '')} target="_blank" rel="noreferrer">{children}</a>;
  return <><a href={artifactUrl(href, source)} onClick={source ? event => {
    event.preventDefault();
    setProblem('');
    void readArtifactBlob(href, source).then(blob => {
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      const filename = href.split('/').at(-1) || 'artifact';
      try { link.download = decodeURIComponent(filename); }
      catch { link.download = filename; }
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    }).catch(error => setProblem(error instanceof Error ? error.message : String(error)));
  } : undefined}>{children}</a>{problem && <span role="alert">{problem}</span>}</>;
}

export function MessageDeliverables({ deliverables, source }: { deliverables?: Deliverable[]; source?: ArtifactSource }) {
  if (!deliverables?.length) return null;
  return <ul className="message-deliverables" aria-label="Deliverables">{deliverables.map((item, index) => <li key={`${item.uri}:${index}`}>
    <MessageLink href={item.uri} source={source}>{item.title || item.uri}</MessageLink>
  </li>)}</ul>;
}
