import type { BaseMessage } from '@langchain/core/messages';
import {
  createAgentMessageManager,
  type DelegationMessageScope,
} from '../messages';
import { projectDelegationAnnouncesForModel } from './delegationAnnounce';

function projectAcceptedAnnounce(message: BaseMessage) {
  return projectDelegationAnnouncesForModel([message])[0]!;
}

/**
 * Location-level convenience API over the shared Agent message manager. Nodes
 * choose an invocation location; canonical querying and view policy remain in
 * one implementation.
 */
export function createOrchestratorMessageViews(
  canonicalMessages: readonly BaseMessage[],
) {
  const manager = createAgentMessageManager(canonicalMessages);
  return Object.freeze({
    entryAnswer() {
      return manager.main({
        name: 'entry_answer',
        audience: 'entry_answer',
        projector: projectAcceptedAnnounce,
      });
    },
    answerFacts() {
      return manager.main({
        name: 'answer_main_facts',
        audience: 'answer',
        toolProtocol: 'preserve',
      });
    },
    capabilityPlannerEntry() {
      return manager.main({
        name: 'capability_planner_entry',
        audience: 'capability_planner',
        toolProtocol: 'preserve',
      });
    },
    capabilityPlannerBoundary(scope: DelegationMessageScope) {
      return manager.delegation({
        name: 'capability_planner_boundary',
        audience: 'capability_planner',
        scope,
        visibility: 'announces_only',
        toolProtocol: 'preserve',
      });
    },
    capabilityPlannerHistory() {
      return manager.main({
        name: 'capability_planner_history',
        audience: 'capability_planner',
        projector: projectAcceptedAnnounce,
      });
    },
    capabilityPlannerProvider(plannerInput: BaseMessage) {
      return manager.main({
        name: 'capability_planner_provider',
        audience: 'capability_planner',
        projector: projectAcceptedAnnounce,
        overlays: [{ id: 'planner_input', messages: [plannerInput] }],
      });
    },
    capabilityCanonical(scope: DelegationMessageScope) {
      return manager.delegation({
        name: 'capability_canonical_transcript',
        audience: scope.lane,
        scope,
      });
    },
    capabilityBase(scope: DelegationMessageScope, briefing: BaseMessage) {
      return manager.delegation({
        name: 'capability_base_invocation',
        audience: scope.lane,
        scope,
        overlays: [{ id: 'delegation_briefing', messages: [briefing] }],
      });
    },
    capabilityModel(
      scope: DelegationMessageScope,
      contextMessages: readonly BaseMessage[],
    ) {
      return manager.delegation({
        name: 'capability_model_invocation',
        audience: scope.lane,
        scope,
        overlays: [{ id: 'delegation_context', messages: contextMessages }],
      });
    },
  });
}
