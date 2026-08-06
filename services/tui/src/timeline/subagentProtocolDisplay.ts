/**
 * Presentation-only recognition for the small set of runtime protocol
 * messages that can appear in the ambient subagent feed. The runtime remains
 * the owner of their structure; this module never feeds parsed data back into
 * session state or control flow.
 */

export function formatSubagentProtocolMessage(text: string): string | null {
  return formatDelegationBriefing(text) ?? formatArtifactDiscoveryContext(text);
}

function formatDelegationBriefing(text: string): string | null {
  const header = readEnvelopeHeader(text, 'delegation_briefing');
  if (
    !header
    || readAttribute(header, 'role') !== 'task_boundary'
    || readAttribute(header, 'source') !== 'orchestrator'
  ) return null;

  const mode = readAttribute(header, 'mode');
  if (mode !== 'initial' && mode !== 'continue') return null;

  const task = readCdataElement(text, 'task');
  if (!task) return null;
  const context = mode === 'continue'
    ? readCdataElement(text, 'gap_note')
    : readCdataElement(text, 'essential_context');

  return [
    `**Delegating${mode === 'continue' ? ' · continuing' : ''}**`,
    task,
    context ? `**Context**\n\n${context}` : null,
  ].filter((part): part is string => part !== null).join('\n\n');
}

function formatArtifactDiscoveryContext(text: string): string | null {
  const header = readEnvelopeHeader(text, 'artifact_discovery_context');
  if (
    !header
    || readAttribute(header, 'role') !== 'fact'
    || readAttribute(header, 'source') !== 'runtime'
    || readAttribute(header, 'trust') !== 'non_authoritative'
  ) return null;

  const scope = readTextElement(text, 'scope');
  return scope ? `Artifact context · ${scope}` : null;
}

function readEnvelopeHeader(text: string, tag: string): string | null {
  const trimmed = text.trim();
  const opening = new RegExp(`^<${tag}\\b([^>]*)>`).exec(trimmed);
  if (!opening || !trimmed.endsWith(`</${tag}>`)) return null;
  return opening[1] ?? '';
}

function readAttribute(header: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(header);
  return match?.[1] ?? null;
}

function readCdataElement(text: string, tag: string): string | null {
  const opening = `<${tag}>`;
  const start = text.indexOf(opening);
  if (start < 0) return null;
  const cdataStart = text.indexOf('<![CDATA[', start + opening.length);
  const end = text.lastIndexOf(`</${tag}>`);
  if (cdataStart < 0 || end < cdataStart) return null;
  const body = text.slice(cdataStart + '<![CDATA['.length, end).trim();
  if (!body.endsWith(']]>')) return null;
  return body.slice(0, -3).replaceAll(']]]]><![CDATA[>', ']]>').trim() || null;
}

function readTextElement(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`).exec(text);
  return match?.[1]?.trim() || null;
}
