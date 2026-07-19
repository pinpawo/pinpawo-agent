import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { getPinpetMeta, setPinpetMeta } from '../messageLanes';
import { indentXmlBlock, xmlTextBlock } from '../prompts/shared';

export const ARTIFACT_DISCOVERY_CONTEXT_SOURCE = 'artifact_discovery_context';
export const ARTIFACT_DISCOVERY_TOOL_NAMES = ['list_dir', 'view_file_chunk'] as const;

export function hasArtifactDiscoveryTools(
  selectedTools: ReadonlyArray<{ name: string }>,
  discoveryTools: ReadonlyArray<{ name: string }>,
): boolean {
  const selectedToolInstances = new Set(selectedTools);
  return ARTIFACT_DISCOVERY_TOOL_NAMES.every((name) => {
    const discoveryTool = discoveryTools.find((toolItem) => toolItem.name === name);
    return discoveryTool ? selectedToolInstances.has(discoveryTool) : false;
  });
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
  if (!contextMessage) return messages;

  // Keep provider-safe message ordering: a compaction SystemMessage must remain
  // first, while the latest delegation briefing remains the final task boundary.
  let briefingIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (getPinpetMeta(messages[index]).source === 'delegation_briefing') {
      briefingIndex = index;
      break;
    }
  }
  const insertionIndex = briefingIndex >= 0 ? briefingIndex : messages.length;
  return [
    ...messages.slice(0, insertionIndex),
    contextMessage,
    ...messages.slice(insertionIndex),
  ];
}
