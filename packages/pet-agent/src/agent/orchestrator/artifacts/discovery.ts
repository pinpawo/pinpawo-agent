import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { setPinpetMeta } from '../messageLanes';
import { indentXmlBlock, xmlTextBlock } from '../prompts/shared';

export const ARTIFACT_DISCOVERY_CONTEXT_SOURCE = 'artifact_discovery_context';
export const ARTIFACT_DISCOVERY_TOOL_NAMES = ['list_dir', 'view_file_chunk'] as const;

export function hasArtifactDiscoveryTools(tools: ReadonlyArray<{ name: string }>): boolean {
  const names = new Set(tools.map((toolItem) => toolItem.name));
  return ARTIFACT_DISCOVERY_TOOL_NAMES.every((name) => names.has(name));
}

export function buildArtifactDiscoveryContextMessage(root: string): AIMessage | null {
  const artifactRoot = root.trim();
  if (!artifactRoot) return null;

  const message = new AIMessage([
    '<artifact_discovery_context role="fact" source="runtime" trust="non_authoritative">',
    indentXmlBlock(xmlTextBlock('current_thread_root', artifactRoot), 2),
    '</artifact_discovery_context>',
  ].join('\n'));
  setPinpetMeta(message, {
    source: ARTIFACT_DISCOVERY_CONTEXT_SOURCE,
    synthetic: true,
  });
  return message;
}

export function withArtifactDiscoveryContext(
  messages: BaseMessage[],
  artifactDiscoveryRoot?: string | null,
): BaseMessage[] {
  const contextMessage = artifactDiscoveryRoot
    ? buildArtifactDiscoveryContextMessage(artifactDiscoveryRoot)
    : null;
  return contextMessage ? [contextMessage, ...messages] : messages;
}
