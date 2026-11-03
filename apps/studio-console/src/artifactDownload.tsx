import React, { useState } from 'react';
import { parseArtifactUri, type Deliverable } from '@pinpawo/agent-contracts';

export type ArtifactAccess = { url: string; token: string };

/** Authentication belongs to the Host connection, never to a saved reference. */
export async function downloadArtifact(reference: Deliverable, access: ArtifactAccess): Promise<void> {
  parseArtifactUri(reference.uri);
  const query = new URLSearchParams({ uri: reference.uri });
  const response = await fetch(`${access.url.replace(/\/$/, '')}/agent-session/artifacts?${query}`, {
    headers: { Authorization: `Bearer ${access.token}` }, credentials: 'omit', redirect: 'follow',
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(failure?.error ?? `Download failed (${response.status}).`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition');
  const encoded = disposition && /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  let name = reference.uri.split('/').at(-1) ?? 'artifact';
  try { name = decodeURIComponent(encoded ?? name); } catch { /* retain the supplied name */ }
  name = name.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, '') || 'artifact';
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.hidden = true;
  document.body.append(anchor);
  try { anchor.click(); } finally {
    anchor.remove();
    // The browser consumes the object URL after the click task completes.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function ArtifactLink({ reference, access }: { reference: Deliverable; access?: ArtifactAccess }) {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');
  const label = reference.title?.trim() ? reference.title : reference.uri;
  if (/^https?:\/\//i.test(reference.uri)) return <a href={reference.uri} target="_blank" rel="noreferrer">{label}</a>;
  let artifact = false;
  try { parseArtifactUri(reference.uri); artifact = true; } catch { /* Other references remain copyable text. */ }
  if (!artifact || !access) return <code>{label}</code>;
  return <><button type="button" className="artifact-download" disabled={state === 'loading'} onClick={() => {
    setState('loading'); setError('');
    void downloadArtifact(reference, access).then(() => setState('idle'), reason => {
      setState('error'); setError(reason instanceof Error ? reason.message : String(reason));
    });
  }}>{state === 'loading' ? 'Downloading…' : label}</button>{state === 'error' && <span role="alert">{error}</span>}</>;
}

export function DeliverableLinks({ references, access }: { references?: readonly Deliverable[]; access?: ArtifactAccess }) {
  return <>{references?.map((reference, index) => <div className="channel-artifact" key={`${reference.uri}:${index}`}>
    <ArtifactLink reference={reference} access={access} />
  </div>)}</>;
}
