import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import type { CapabilityArtifactRef } from '../../../types/artifact';
import type {
  CapabilityCandidate,
  RunDelegationSummary,
  SubagentAnnounce,
  SubagentCompletionReason,
} from '../types';
import { clipForPrompt, formatDelegationStatus, readMessageText } from '../utils';
import { indentXmlBlock, MAX_DECISION_RUN_DELEGATIONS, xmlTextBlock } from './shared';
import { isDelegationBriefingMessage } from '../delegationBriefing';

const MAX_RECENT_MAIN_MESSAGES = 6;
const MAX_RECENT_ANNOUNCE_CONTEXT = 5;
const MAX_CONTEXT_SUMMARIES = 2;
const MAX_RECENT_CAPABILITY_ARTIFACTS = 6;

export function buildCapabilityArtifactContext(artifacts: CapabilityArtifactRef[] | undefined): string {
  if (!artifacts || artifacts.length === 0) return '';
  const lines = ['当前会话 capability artifacts（仅短引用；需要细节时交给对应 capability/host 按 ref 读取）：'];
  for (const artifact of artifacts.slice(-MAX_RECENT_CAPABILITY_ARTIFACTS)) {
    lines.push(`- [${artifact.kind}] ${clipForPrompt(artifact.title ?? artifact.id, 120)}`);
    lines.push(`  capability: ${artifact.capabilityId}; uri: ${artifact.uri}`);
    if (artifact.preview) {
      lines.push(`  preview: ${clipForPrompt(artifact.preview, 240)}`);
    }
  }
  return lines.join('\n');
}

export function buildRunDelegationSummaryContext(runDelegationSummaries: RunDelegationSummary[]): string {
  if (runDelegationSummaries.length === 0) {
    return '当前 run 任务跟踪：\n- 暂无 delegated task。';
  }

  const visibleDelegations = runDelegationSummaries.slice(-MAX_DECISION_RUN_DELEGATIONS);
  const lines = [
    '当前 run 任务跟踪（仅保留本 run 近期任务）',
    visibleDelegations.some((delegation) => delegation.status !== 'completed')
      ? '- 存在尚未 completed 的 delegated task。'
      : '- 所有 delegated task 均为 completed。',
  ];

  for (const delegation of visibleDelegations) {
    lines.push('');
    lines.push(`任务 ${delegation.id}`);
    lines.push(`- 执行器：${delegation.lane}`);
    lines.push(`- 任务目标：${clipForPrompt(delegation.task, 160)}`);
    lines.push(`- 状态：${formatDelegationStatus(delegation.status)}`);
    if (delegation.resultPreview) {
      lines.push(`- 结果摘要：${clipForPrompt(delegation.resultPreview, 220)}`);
    }
  }
  return lines.join('\n');
}

export function buildRouteTargetsContext(params: {
  generalTools: StructuredTool[];
  capabilityCandidates: CapabilityCandidate[];
  capabilitySearchAttempted: boolean;
  capabilitySearchQuery: string | null;
  capabilityRegistryAvailable?: boolean;
}): string {
  const lines = ['Capability decision facts：'];
  if (params.generalTools.length > 0) {
    lines.push('', 'general capability（可使用下列通用工具）：');
    for (const toolItem of params.generalTools) {
      lines.push(`- ${toolItem.name}: ${clipForPrompt(toolItem.description, 140)}`);
    }
  } else {
    lines.push('', 'general capability：不可用');
  }

  if (params.capabilityCandidates.length > 0) {
    lines.push('', 'custom capability 候选：');
    for (const candidate of params.capabilityCandidates) {
      const matchedTerms = candidate.matchedTerms.length > 0
        ? `；匹配：${candidate.matchedTerms.join('|')}`
        : '';
      lines.push(`- capability.${candidate.name}：${clipForPrompt(candidate.description, 180)}${matchedTerms}`);
    }
  } else if (params.capabilitySearchAttempted) {
    lines.push('', 'custom capability：已搜索，未找到匹配候选。');
    if (params.capabilitySearchQuery) {
      lines.push(`- 搜索 query：${clipForPrompt(params.capabilitySearchQuery, 120)}`);
    }
  } else if (params.capabilityRegistryAvailable) {
    lines.push('', 'custom capability：当前没有候选。');
  } else {
    lines.push('', 'custom capability：不可用');
  }
  return lines.join('\n');
}

export function buildRecentSubagentAnnounceContext(announces: SubagentAnnounce[]): string {
  if (announces.length === 0) return '';
  const lines = ['最近 subagent announce（用于理解“之前/刚刚/继续/完成了吗”等指代）：'];
  for (const item of announces.slice(-MAX_RECENT_ANNOUNCE_CONTEXT)) {
    lines.push(`- ${item.delegationId ? `[${item.delegationId}] ` : ''}${item.lane}`);
    if (item.task) lines.push(`  delegated task：${clipForPrompt(item.task, 140)}`);
    if (item.text) lines.push(`  返回摘要：${clipForPrompt(item.text, 220)}`);
  }
  return lines.join('\n');
}

function buildRecentSubagentAnnounceXmlContext(announces: SubagentAnnounce[]): string | null {
  if (announces.length === 0) return null;
  const lines = ['<recent_subagent_announces purpose="coreference">'];
  for (const item of announces.slice(-MAX_RECENT_ANNOUNCE_CONTEXT)) {
    lines.push('  <announce>');
    if (item.delegationId) lines.push(`    <delegation_id>${item.delegationId}</delegation_id>`);
    lines.push(`    <lane>${item.lane}</lane>`);
    if (item.task) lines.push(indentXmlBlock(xmlTextBlock('task', clipForPrompt(item.task, 140)), 4));
    if (item.text) lines.push(indentXmlBlock(xmlTextBlock('summary', item.text), 4));
    lines.push('  </announce>');
  }
  lines.push('</recent_subagent_announces>');
  return lines.join('\n');
}

export function buildUserRequestContext(userRequest: string | null): string | null {
  return userRequest ? `用户原始请求：${clipForPrompt(userRequest, 320)}` : null;
}

export function buildRuntimeContext(workdir?: string, runtimeEnvironment?: string): string | null {
  if (!workdir && !runtimeEnvironment) return null;
  return [
    '<runtime_context role="fact" source="runtime">',
    workdir ? indentXmlBlock(xmlTextBlock('workdir', clipForPrompt(workdir, 320)), 2) : null,
    runtimeEnvironment
      ? indentXmlBlock(xmlTextBlock('runtime_environment', clipForPrompt(runtimeEnvironment, 1200)), 2)
      : null,
    '</runtime_context>',
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function formatSubagentAnnounceArtifactRefs(item: SubagentAnnounce): string | null {
  if (!item.artifactRefs || item.artifactRefs.length === 0) return null;
  const lines = ['  <artifacts>'];
  for (const ref of item.artifactRefs) {
    lines.push('    <artifact>');
    lines.push(`      <uri>${clipForPrompt(ref.uri, 260)}</uri>`);
    lines.push(`      <capability>${clipForPrompt(ref.capabilityId, 120)}</capability>`);
    lines.push(`      <kind>${ref.kind}</kind>`);
    if (ref.title) lines.push(`      <title>${clipForPrompt(ref.title, 140)}</title>`);
    if (ref.preview) lines.push(indentXmlBlock(xmlTextBlock('preview', clipForPrompt(ref.preview, 180)), 6));
    lines.push('    </artifact>');
  }
  lines.push('  </artifacts>');
  return lines.join('\n');
}

export function buildSubagentAnnounceContext(
  item: SubagentAnnounce | null,
  completionReason?: SubagentCompletionReason | null,
): string | null {
  if (!item) return null;
  // Do not pre-classify the announce: outcomeDecision owns completion judgment.
  const resultBlock = item.text
    ? xmlTextBlock('result', item.text.trim(), ' format="markdown" role="data"')
    : null;
  return [
    '<subagent_announce>',
    item.delegationId ? `  <delegation_id>${item.delegationId}</delegation_id>` : null,
    `  <lane>${item.lane}</lane>`,
    completionReason ? `  <stop_reason>${completionReason}</stop_reason>` : null,
    resultBlock ? indentXmlBlock(resultBlock, 2) : null,
    formatSubagentAnnounceArtifactRefs(item),
    '</subagent_announce>',
  ].filter(Boolean).join('\n');
}

function messageRoleLabel(message: BaseMessage): string {
  if (isDelegationBriefingMessage(message)) return '委派简报';
  const type = message._getType();
  if (type === 'human') return '用户';
  if (type === 'ai') return '助手';
  if (type === 'system') return '系统';
  return type;
}

function buildCompactionSummaryXmlContext(contextSummaries: string[] | undefined): string | null {
  const visibleSummaries = (contextSummaries ?? [])
    .slice(-MAX_CONTEXT_SUMMARIES)
    .map((summary) => clipForPrompt(summary, 1200))
    .filter(Boolean);
  if (visibleSummaries.length === 0) return null;
  const lines = ['<context_summaries source="compaction" role="context">'];
  visibleSummaries.forEach((summary, index) => {
    lines.push(indentXmlBlock(xmlTextBlock('summary', summary, ` index="${(index + 1).toString()}"`), 2));
  });
  lines.push('</context_summaries>');
  return lines.join('\n');
}

function buildRecentMessagesXmlContext(messages: BaseMessage[]): string | null {
  const entries = messages
    .slice(-MAX_RECENT_MAIN_MESSAGES)
    .map((message) => {
      const text = readMessageText(message);
      return text ? { role: messageRoleLabel(message), text: clipForPrompt(text, 220) } : null;
    })
    .filter((entry): entry is { role: string; text: string } => Boolean(entry));
  if (entries.length === 0) return null;

  const lines = ['<recent_messages purpose="coreference">'];
  for (const entry of entries) {
    lines.push('  <message>');
    lines.push(`    <role>${entry.role}</role>`);
    lines.push(indentXmlBlock(xmlTextBlock('text', entry.text), 4));
    lines.push('  </message>');
  }
  lines.push('</recent_messages>');
  return lines.join('\n');
}

export function buildPreparedRequestContext(params: {
  latestUserRequest: string | null;
  recentMessages: BaseMessage[];
  recentAnnounces: SubagentAnnounce[];
  contextSummaries?: string[];
  capabilityArtifacts?: CapabilityArtifactRef[];
}): string {
  const compactionSummaryContext = buildCompactionSummaryXmlContext(params.contextSummaries);
  const artifactContext = buildCapabilityArtifactContext(params.capabilityArtifacts);
  const recentAnnouncesContext = buildRecentSubagentAnnounceXmlContext(params.recentAnnounces);
  const recentMessagesContext = buildRecentMessagesXmlContext(params.recentMessages);
  return [
    '<user_intent_context>',
    params.latestUserRequest
      ? indentXmlBlock(xmlTextBlock('user_request', clipForPrompt(params.latestUserRequest, 420)), 2)
      : '  <user_request missing="true" />',
    compactionSummaryContext ? indentXmlBlock(compactionSummaryContext, 2) : null,
    artifactContext ? indentXmlBlock(xmlTextBlock('capability_artifacts', artifactContext), 2) : null,
    recentAnnouncesContext ? indentXmlBlock(recentAnnouncesContext, 2) : null,
    recentMessagesContext ? indentXmlBlock(recentMessagesContext, 2) : null,
    '</user_intent_context>',
  ].filter((line) => line !== null).join('\n');
}
