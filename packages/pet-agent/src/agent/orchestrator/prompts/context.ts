import type { BaseMessage } from '@langchain/core/messages';
import type { CapabilityArtifactRef } from '../../../types/artifact';
import type {
  RunDelegationSummary,
  SubagentAnnounce,
  SubagentCompletionReason,
} from '../types';
import { clipForPrompt, formatDelegationStatus, readMessageText } from '../utils';
import { indentXmlBlock, MAX_DECISION_RUN_DELEGATIONS, xmlTextBlock } from './shared';
import { isDelegationBriefingMessage } from '../delegationBriefing';

const MAX_RECENT_MAIN_MESSAGES = 6;
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

export function buildCompactionSummaryXmlContext(contextSummaries: string[] | undefined): string | null {
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

type PreparedRequestContextParams = {
  latestUserRequest: string | null;
  recentMessages: BaseMessage[];
  contextSummaries?: string[];
  capabilityArtifacts?: CapabilityArtifactRef[];
};

function recentMessagesWithoutCurrentRequest(
  messages: BaseMessage[],
  latestUserRequest: string | null,
) {
  if (!latestUserRequest) return messages;
  const visibleMessages = [...messages];
  for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
    const message = visibleMessages[index];
    if (
      message._getType() === 'human'
      && readMessageText(message) === latestUserRequest
    ) {
      visibleMessages.splice(index, 1);
      break;
    }
  }
  return visibleMessages;
}

export function buildPreparedRequestContextFragment(
  params: PreparedRequestContextParams,
): string {
  const compactionSummaryContext = buildCompactionSummaryXmlContext(params.contextSummaries);
  const artifactContext = buildCapabilityArtifactContext(params.capabilityArtifacts);
  const recentMessagesContext = buildRecentMessagesXmlContext(
    recentMessagesWithoutCurrentRequest(
      params.recentMessages,
      params.latestUserRequest,
    ),
  );
  return [
    params.latestUserRequest
      ? xmlTextBlock('user_request', clipForPrompt(params.latestUserRequest, 420))
      : '<user_request missing="true" />',
    compactionSummaryContext,
    artifactContext ? xmlTextBlock('capability_artifacts', artifactContext) : null,
    recentMessagesContext,
  ].filter((line) => line !== null).join('\n');
}

export function buildPreparedRequestContext(
  params: PreparedRequestContextParams,
): string {
  return [
    '<user_intent_context>',
    indentXmlBlock(buildPreparedRequestContextFragment(params), 2),
    '</user_intent_context>',
  ].join('\n');
}
