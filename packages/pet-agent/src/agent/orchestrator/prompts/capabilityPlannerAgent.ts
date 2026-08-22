import type { CapabilityPlannerInput } from '../capabilityPlanner/runner';
import type { CapabilityPlannerDefaultCapability } from '../capabilityPlanner/fileExplorer';
import {
  CAPABILITY_PLANNER_BOUNDARY_INPUT_PROMPT,
  CAPABILITY_PLANNER_BOUNDARY_SYSTEM_PROMPT,
  CAPABILITY_PLANNER_ENTRY_INPUT_PROMPT,
  CAPABILITY_PLANNER_ENTRY_SYSTEM_PROMPT,
} from './templates/capabilityPlannerAgent.prompt';
import { buildRunUserRequestContext } from './context';
import { promptBlock, xmlTextBlock } from './shared';

function buildDefaultCapabilityContext(
  defaultCapability: CapabilityPlannerDefaultCapability | null,
) {
  if (!defaultCapability) return '';
  return xmlTextBlock(
    'default_capability',
    defaultCapability.content,
    ` name="${defaultCapability.capabilityName}"`,
  );
}

function buildPlanningState(input: CapabilityPlannerInput) {
  const lines: string[] = [];
  if (input.activeDelegation) {
    lines.push(`当前 Capability：${input.activeDelegation.capability}`);
    lines.push(`当前任务：${input.activeDelegation.task}`);
  }
  if (input.latestAnnounce) {
    if (input.latestAnnounce.completionReason) {
      lines.push(`执行停止原因：${input.latestAnnounce.completionReason}`);
    }
  }
  if (input.remainingPlan.length > 0) {
    lines.push('此前保留的后续任务：');
    for (const task of input.remainingPlan) {
      lines.push(`- [${task.capability}] ${task.task}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : '无。';
}

/**
 * The default capability is a property of the immutable workspace, not of this
 * turn's request, so it belongs in the system message. Rendering it beside
 * <run_user_request> put a run-stable workspace fact in the same block as the
 * one thing that changes every turn.
 */
export function buildCapabilityPlannerAgentSystemPrompt(
  mode: CapabilityPlannerInput['mode'],
  defaultCapability: CapabilityPlannerDefaultCapability | null = null,
  exploration: {
    status: 'open' | 'closed';
    roundsUsed: number;
    maxRounds: number;
  } = { status: 'open', roundsUsed: 0, maxRounds: 2 },
) {
  const defaultCapabilityContext = promptBlock(
    buildDefaultCapabilityContext(defaultCapability),
    0,
  );
  const prompt = mode === 'entry'
    ? CAPABILITY_PLANNER_ENTRY_SYSTEM_PROMPT.render({ defaultCapabilityContext })
    : CAPABILITY_PLANNER_BOUNDARY_SYSTEM_PROMPT.render({ defaultCapabilityContext });
  const remainingRounds = Math.max(0, exploration.maxRounds - exploration.roundsUsed);
  const searchState = [
    '<capability_search_state',
    ` status="${exploration.status}"`,
    ` rounds_used="${exploration.roundsUsed.toString()}"`,
    ` remaining_rounds="${remainingRounds.toString()}"`,
    ' />',
  ].join('');
  return [prompt, searchState].join('\n');
}

export function buildCapabilityPlannerAgentInput(input: CapabilityPlannerInput) {
  const userRequest = buildRunUserRequestContext(input.userRequest);
  return input.mode === 'entry'
    ? CAPABILITY_PLANNER_ENTRY_INPUT_PROMPT.render({ userRequest })
    : CAPABILITY_PLANNER_BOUNDARY_INPUT_PROMPT.render({
      userRequest,
      planningState: buildPlanningState(input),
    });
}
