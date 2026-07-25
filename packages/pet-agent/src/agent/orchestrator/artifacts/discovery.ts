import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { getPinpetMeta, setPinpetMeta } from '../messageLanes';

export const ARTIFACT_DISCOVERY_CONTEXT_SOURCE = 'artifact_discovery_context';
export const ARTIFACT_DISCOVERY_TOOLKIT_NAME = 'artifact_discovery';
export const ARTIFACT_DISCOVERY_LIST_TOOL_NAME = 'artifact_list';
export const ARTIFACT_DISCOVERY_READ_TOOL_NAME = 'artifact_read';
export const ARTIFACT_DISCOVERY_TOOL_NAMES = [
  ARTIFACT_DISCOVERY_LIST_TOOL_NAME,
  ARTIFACT_DISCOVERY_READ_TOOL_NAME,
] as const;

export function hasArtifactDiscoveryToolkit(
  toolkits: ReadonlyArray<{ name: string }>,
): boolean {
  return toolkits.some(({ name }) => name === ARTIFACT_DISCOVERY_TOOLKIT_NAME);
}

export function buildArtifactDiscoveryContextMessage(): AIMessage {
  const message = new AIMessage([
    '<artifact_discovery_context role="fact" source="runtime" trust="non_authoritative">',
    '  <scope>current_thread</scope>',
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
  enabled: boolean,
): BaseMessage[] {
  if (!enabled) return messages;
  const contextMessage = buildArtifactDiscoveryContextMessage();

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
