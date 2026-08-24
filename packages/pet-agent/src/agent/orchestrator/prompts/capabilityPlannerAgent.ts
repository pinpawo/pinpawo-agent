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
import { getDelegationAnnounce } from '../delegationAnnounce';
import { readMessageText } from '../utils';

const PRIOR_CONTEXT_SUMMARY = /<essential_context\b[^>]*\bsource=(?:"prior_summary"|'prior_summary')/i;

function latestAnnounceText(input: CapabilityPlannerInput) {
  const messageId = input.latestAnnounce?.messageId;
  if (!messageId) return null;
  const message = input.messages.find(({ id }) => id === messageId);
  if (!message) return null;
  return getDelegationAnnounce(message)?.result ?? readMessageText(message);
}

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
    const announceText = latestAnnounceText(input);
    if (announceText && PRIOR_CONTEXT_SUMMARY.test(announceText)) {
      lines.push('最新交接消息类型：此前上下文摘要；它描述已知状态，不表示当前任务已实际执行或验收。');
    }
  }
  if (input.remainingPlan.length > 0) {
    lines.push('此前保留的后续任务：');
    for (const task of input.remainingPlan) {
      lines.push(`- [${task.capability}] ${task.task}`);
    }
    lines.push('交接事实会随执行 lane 传递给后续 Capability；这些任务文本只定义待交付的边界。');
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
) {
  const defaultCapabilityContext = promptBlock(
    buildDefaultCapabilityContext(defaultCapability),
    0,
  );
  const prompt = mode === 'entry'
    ? CAPABILITY_PLANNER_ENTRY_SYSTEM_PROMPT.render({ defaultCapabilityContext })
    : CAPABILITY_PLANNER_BOUNDARY_SYSTEM_PROMPT.render({ defaultCapabilityContext });
  return prompt;
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
