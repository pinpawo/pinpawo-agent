import type { CapabilityPlannerInput } from '../capabilityPlanner/runner';
import type { CapabilityPlannerDefaultCapability } from '../capabilityPlanner/fileExplorer';
import {
  CAPABILITY_PLANNER_BOUNDARY_INPUT_PROMPT,
  CAPABILITY_PLANNER_BOUNDARY_SYSTEM_PROMPT,
  CAPABILITY_PLANNER_ENTRY_INPUT_PROMPT,
  CAPABILITY_PLANNER_ENTRY_SYSTEM_PROMPT,
} from './templates/capabilityPlannerAgent.prompt';
import { buildRunUserRequestContext } from './context';
import { indentXmlBlock, promptBlock, xmlTextBlock } from './shared';

function buildDefaultCapabilityContext(
  defaultCapability: CapabilityPlannerDefaultCapability | null,
) {
  if (!defaultCapability) return '';
  return [
    '<default_capability role="fallback_executor" priority="after_specific_candidates" source="capability_registry" trust="read_only">',
    indentXmlBlock(xmlTextBlock('name', defaultCapability.capabilityName), 2),
    indentXmlBlock(xmlTextBlock('path', defaultCapability.path), 2),
    indentXmlBlock(xmlTextBlock('document', defaultCapability.content), 2),
    '</default_capability>',
  ].join('\n');
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
    lines.push('计划更新规则：默认逐项原样复用此前保留的后续任务；accepted handoff 会直接提供给后续执行方，其中的新细节不是改写 task 的理由。只有最新结果证明原计划不再必要、不可执行或不足以正确覆盖用户目标时才修改，并且只修改必要的最小部分。');
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
  const explorationControl = exploration.status === 'open'
    ? [
        `<capability_exploration status="open" rounds_used="${exploration.roundsUsed.toString()}" max_rounds="${exploration.maxRounds.toString()}" remaining_rounds="${remainingRounds.toString()}">`,
        'capability_search 当前可用，用于寻找比 General 更具体的执行方。已披露的具体 Capability 能完成当前 task 时优先选择它；General 只是兜底。候选已经足够时立即提交终结动作，不必用完剩余轮次。',
        '</capability_exploration>',
      ]
    : [
        `<capability_exploration status="closed" rounds_used="${exploration.roundsUsed.toString()}" max_rounds="${exploration.maxRounds.toString()}" remaining_rounds="0">`,
        '候选披露已经完成，capability_search 不再可用。先评估已披露的具体 Capability；其中任何一个能完成当前 task 时不得改选 General。只有具体候选都不适用时才使用 General。现在调用一个终结工具。',
        '</capability_exploration>',
      ];
  return [prompt, ...explorationControl].join('\n');
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
