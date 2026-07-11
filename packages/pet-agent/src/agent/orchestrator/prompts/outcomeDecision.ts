import type { AgentActor } from '../../../types/agent';
import type { CapabilityArtifactRef } from '../../../types/artifact';
import type { RunDelegationSummary } from '../types';
import { clipForPrompt, formatDelegationStatus } from '../utils';
import { buildCapabilityArtifactContext } from './context';
import {
  buildDecisionConfigLines,
  buildOrchestratorDecisionPromptPrefixLines,
  indentXmlBlock,
  MAX_DECISION_RUN_DELEGATIONS,
  xmlTextBlock,
} from './shared';

export function buildDelegationOutcomeCurrentTaskContext(task: {
  id: string;
  lane: string;
  task: string;
  contextSummary: string | null;
} | null): string | null {
  if (!task) return null;
  const lines = [
    '<current_delegation>',
    `  <delegation_id>${task.id}</delegation_id>`,
    `  <lane>${task.lane}</lane>`,
    indentXmlBlock(xmlTextBlock('task', clipForPrompt(task.task, 240)), 2),
  ].filter((line): line is string => Boolean(line));
  if (task.contextSummary) {
    lines.push(indentXmlBlock(xmlTextBlock('context_summary', clipForPrompt(task.contextSummary, 320)), 2));
  }
  lines.push('</current_delegation>');
  return lines.join('\n');
}

export function buildDelegationOutcomeOtherTasksContext(
  runDelegationSummaries: RunDelegationSummary[],
  activeDelegationId: string | null,
): string {
  const otherDelegations = activeDelegationId
    ? runDelegationSummaries.filter((delegation) => delegation.id !== activeDelegationId)
    : runDelegationSummaries;
  if (otherDelegations.length === 0) {
    return ['<other_delegations>', '  <none>true</none>', '</other_delegations>'].join('\n');
  }

  const lines = ['<other_delegations>'];
  for (const delegation of otherDelegations.slice(-MAX_DECISION_RUN_DELEGATIONS)) {
    lines.push('  <delegation>');
    lines.push(`    <delegation_id>${delegation.id}</delegation_id>`);
    lines.push(`    <lane>${delegation.lane}</lane>`);
    lines.push(`    <status>${formatDelegationStatus(delegation.status)}</status>`);
    lines.push(indentXmlBlock(xmlTextBlock('task', clipForPrompt(delegation.task, 160)), 4));
    if (delegation.resultPreview) {
      lines.push(indentXmlBlock(xmlTextBlock('result_preview', clipForPrompt(delegation.resultPreview, 220)), 4));
    }
    lines.push('  </delegation>');
  }
  lines.push('</other_delegations>');
  return lines.join('\n');
}

export function buildDelegationOutcomeDecisionSystemPrompt(params: {
  actor: AgentActor;
  outputInstruction: string;
}): string {
  return [
    ...buildDecisionConfigLines(params.actor),
    '',
    ...buildOrchestratorDecisionPromptPrefixLines(),
    '',
    '当前阶段：delegationOutcomeDecision（subagent 返回后的结果验收）。',
    '当前节点：子任务结果验收节点。你的唯一职责是判断当前 delegated task 和当前 run 目标的完成度。',
    '节点边界：不要回答用户、不要总结 subagent 结果、不要生成下一步 task、不要选择 general/capability lane、不要执行工具；最终回复由后续 answer 节点生成。',
    '',
    '决策条件：',
    '- outcome=continue：',
    '  - 当前 delegated task 尚未形成可接受结果。',
    '  - 同一 capability 继续执行仍能推进当前 task，且继续前不需要用户补充信息。',
    '  - gap_note 简述当前 task 的具体缺口；不要改变 task 或选择新的 capability。',
    '- outcome=task_done：',
    '  - 当前 delegated task 已形成可接受结果。',
    '  - 但根据用户目标和已有结论，不能明确断言整个用户目标已经完成。',
    '  - 不生成下一步 task；系统 handoff 后由 capabilityPlanner 判断、修订或取消后续工作。',
    '- outcome=goal_done：',
    '  - 当前 announce 和已有结论已经足以满足用户目标；或继续前需要用户补充、澄清、确认。',
    '  - 不再自主执行，交给 answer；不要在本节点撰写最终回复或直接提问。',
    '- 所有 outcome 都依据：',
    '  - 用户原始请求用于判断当前 run 的总目标。',
    '  - 当前 delegated task 用于判断本次执行原本要完成什么。',
    '  - subagent announce 原文是判断当前 task 是否达标的主要执行证据。',
    '  - 其他 run 结论只用于判断用户目标，不替代当前 announce 对当前 task 的验收。',
    '  - outcome 只表达 verdict；不要输出 task、plan、context summary、search keywords、lane 或 capability。',
    '  - 本节点不接收工具列表，也不依赖 capability 枚举或 plan 内容。',
    '',
    '动态上下文内容：',
    '- user_intent_context：用户请求、近期主对话和压缩摘要，用来恢复并判断当前 run 的总目标。',
    '- current_delegation：当前 active delegated task、lane、task 文本和必要 context summary。',
    '- subagent_announce：当前执行 lane 返回的 announce 原文，是判断 task 是否达标的主要证据。',
    '- other_delegations：同一 run 里其他 delegated task 的账本摘要，用来避免重复判断。',
    '- capability_artifacts：可选 artifact 短引用，只作为结果证据索引，不替代 announce 原文。',
    '',
    params.outputInstruction,
  ].filter((line) => line !== null).join('\n');
}

export function buildDelegationOutcomeDecisionInput(params: {
  userIntentContext: string;
  currentTaskContext: string | null;
  subagentAnnounceContext: string | null;
  otherTasksContext?: string | null;
  capabilityArtifacts?: CapabilityArtifactRef[];
}): string {
  const artifactContext = buildCapabilityArtifactContext(params.capabilityArtifacts);
  return [
    '<delegation_outcome_input>',
    indentXmlBlock(params.userIntentContext, 2),
    params.currentTaskContext
      ? indentXmlBlock(params.currentTaskContext, 2)
      : '  <current_delegation missing="true" />',
    params.subagentAnnounceContext
      ? indentXmlBlock(params.subagentAnnounceContext, 2)
      : '  <subagent_announce missing="true" />',
    params.otherTasksContext ? indentXmlBlock(params.otherTasksContext, 2) : null,
    artifactContext ? indentXmlBlock(xmlTextBlock('capability_artifacts', artifactContext), 2) : null,
    '</delegation_outcome_input>',
  ].filter((line) => line !== null).join('\n');
}
