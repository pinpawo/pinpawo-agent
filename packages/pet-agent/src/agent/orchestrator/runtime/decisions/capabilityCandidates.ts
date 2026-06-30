import type { BaseMessage } from '@langchain/core/messages';
import type { AgentModels } from '../../../../types/agent';
import type { AgentCapability } from '../../../../types/capability';
import { isContextCompactionMessage } from '../../contextCompaction';
import { mainConversationMessages } from '../../messageLanes';
import type {
  CapabilityCandidate,
  CapabilityDecisionState,
  MessageLane,
  ToolBindableChatModel,
} from '../../types';

export function canSearchCapabilities(
  model: AgentModels['act'],
  state: { runCapabilitySearchState: { attempted: boolean; candidates: CapabilityCandidate[] } },
  capabilities: AgentCapability[],
): model is ToolBindableChatModel {
  return capabilities.length > 0
    && !state.runCapabilitySearchState.attempted
    && state.runCapabilitySearchState.candidates.length === 0
    && typeof (model as ToolBindableChatModel).bindTools === 'function';
}

export function resolveCapabilityDecisionState(params: {
  canSearch: boolean;
  capabilityCandidates: CapabilityCandidate[];
  capabilitySearchAttempted: boolean;
}): CapabilityDecisionState {
  if (params.capabilityCandidates.length > 0) return 'candidates_available';
  if (params.canSearch) return 'search_available';
  if (params.capabilitySearchAttempted) return 'search_exhausted';
  return 'unavailable';
}

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

export function mergeCapabilityCandidates(...groups: CapabilityCandidate[][]): CapabilityCandidate[] {
  const candidates: CapabilityCandidate[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const candidate of group) {
      if (seen.has(candidate.name)) continue;
      seen.add(candidate.name);
      candidates.push(candidate);
    }
  }
  return candidates;
}
