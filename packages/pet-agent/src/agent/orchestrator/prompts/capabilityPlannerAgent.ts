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
import { readMessageText } from '../utils';

function buildDefaultCapabilityContext(
  defaultCapability: CapabilityPlannerDefaultCapability | null,
) {
  if (!defaultCapability) return '';
  return [
    '<default_capability role="default_executor" source="immutable_workspace" trust="read_only">',
    indentXmlBlock(xmlTextBlock('name', defaultCapability.capabilityName), 2),
    indentXmlBlock(xmlTextBlock('path', defaultCapability.path), 2),
    indentXmlBlock(xmlTextBlock('document', defaultCapability.content), 2),
    '</default_capability>',
  ].join('\n');
}

function buildPlanningState(input: CapabilityPlannerInput) {
  const lines: string[] = [];
  if (input.latestUserMessage) {
    lines.push(`最新用户消息：${input.latestUserMessage}`);
  }
  if (input.activeDelegation) {
    lines.push(`当前 Capability：${input.activeDelegation.capability}`);
    lines.push(`当前任务：${input.activeDelegation.task}`);
    lines.push(`当前 delegation ID：${input.activeDelegation.delegationId}`);
  }
  if (input.latestAnnounce) {
    if (input.latestAnnounce.completionReason) {
      lines.push(`执行停止原因：${input.latestAnnounce.completionReason}`);
    }
    if (input.latestAnnounce.text) {
      lines.push(`待验收的执行结果：${input.latestAnnounce.text}`);
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

function buildMainConversationContext(input: CapabilityPlannerInput) {
  const mainMessages = input.mainMessages ?? [];
  if (input.mode !== 'entry' || mainMessages.length === 0) return '';
  let currentRequestIndex = -1;
  for (let index = mainMessages.length - 1; index >= 0; index -= 1) {
    if (mainMessages[index]?._getType() === 'human') {
      currentRequestIndex = index;
      break;
    }
  }
  const messages = mainMessages.flatMap((message, index) => {
    if (index === currentRequestIndex) return [];
    const text = readMessageText(message);
    if (!text) return [];
    const role = message._getType() === 'human' ? 'user' : 'assistant';
    return [indentXmlBlock(xmlTextBlock('message', text, ` role="${role}"`), 2)];
  });
  if (messages.length === 0) return '';
  return [
    '<main_conversation role="context" source="orchestrator_state" trust="read_only">',
    ...messages,
    '</main_conversation>',
  ].join('\n');
}

export function buildCapabilityPlannerAgentSystemPrompt(
  mode: CapabilityPlannerInput['mode'],
) {
  return mode === 'entry'
    ? CAPABILITY_PLANNER_ENTRY_SYSTEM_PROMPT.render({})
    : CAPABILITY_PLANNER_BOUNDARY_SYSTEM_PROMPT.render({});
}

export function buildCapabilityPlannerAgentInput(
  input: CapabilityPlannerInput,
  defaultCapability: CapabilityPlannerDefaultCapability | null = null,
) {
  const userRequest = buildRunUserRequestContext(input.userRequest);
  const defaultCapabilityContext = promptBlock(
    buildDefaultCapabilityContext(defaultCapability),
    0,
  );
  const mainConversationContext = promptBlock(buildMainConversationContext(input), 0);
  return input.mode === 'entry' && !input.latestUserMessage
    ? CAPABILITY_PLANNER_ENTRY_INPUT_PROMPT.render({
      defaultCapabilityContext,
      mainConversationContext,
      userRequest,
    })
    : CAPABILITY_PLANNER_BOUNDARY_INPUT_PROMPT.render({
      defaultCapabilityContext,
      userRequest,
      planningState: buildPlanningState(input),
    });
}
