import type { BaseMessage } from '@langchain/core/messages';
import type { AgentCapability } from '../../../../types/capability';
import { isContextCompactionMessage } from '../../contextCompaction';
import { mainConversationMessages } from '../../messageLanes';
import type {
  CapabilityCandidate,
  MessageLane,
} from '../../types';

function readCapabilityNameFromLane(lane: MessageLane): string | null {
  return lane.startsWith('capability:') ? lane.slice('capability:'.length) : null;
}

export function mainMessagesWithoutCompaction(messages: BaseMessage[]): BaseMessage[] {
  return mainConversationMessages(messages).filter((message) => !isContextCompactionMessage(message));
}

export function buildCapabilityCandidatesFromLanes(
  capabilityList: AgentCapability[],
  lanes: Array<MessageLane | null | undefined>,
): CapabilityCandidate[] {
  const candidates: CapabilityCandidate[] = [];
  const seen = new Set<string>();
  for (const lane of lanes) {
    if (!lane) continue;
    const capabilityName = readCapabilityNameFromLane(lane);
    if (!capabilityName || seen.has(capabilityName)) continue;
    const capability = capabilityList.find((item) => item.name === capabilityName);
    if (!capability) continue;
    seen.add(capabilityName);
    candidates.push({
      name: capability.name,
      description: capability.description,
      score: Number.POSITIVE_INFINITY,
      matchedTerms: ['in_progress'],
    });
  }
  return candidates;
}
