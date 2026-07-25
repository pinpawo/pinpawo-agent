import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import {
  ARTIFACT_DISCOVERY_TOOLKIT_NAME,
  clipForPrompt,
  defineCapability,
  defineInstructionDocument,
  invokeStructuredOutput,
} from '@pinpawo/pet-agent';
import { randomUUID } from 'node:crypto';
import type {
  AgentCapability,
  CapabilityArtifactStore,
  CapabilityFinalizeContext,
  OrchestrationDecisionStructuredOutputConfig,
} from '@pinpawo/pet-agent';
import { z } from 'zod';

const DEFAULT_EXPLORE_TOOLKITS = [
  'bash',
  'git',
  'browser',
  ARTIFACT_DISCOVERY_TOOLKIT_NAME,
] as const;

export type ExploreResult = {
  status: 'progress' | 'completed';
  summary: string;
  nextSteps: string[];
};

export type ExploreCapabilityOptions = {
  structuredOutput?: OrchestrationDecisionStructuredOutputConfig;
  uses?: readonly string[];
};

const exploreEvidenceItemSchema = z.object({
  source: z.string().min(1),
  proves: z.string().min(1),
  value: z.string().min(1),
});

const exploreKnowledgeIngestSchema = z.object({
  summary: z.string().min(1),
  evidence: z.array(exploreEvidenceItemSchema).default([]),
});

export type ExploreEvidenceItem = z.infer<typeof exploreEvidenceItemSchema>;
export type ExploreKnowledgeIngest = z.infer<typeof exploreKnowledgeIngestSchema>;

const EXPLORE_SUMMARY_TRANSCRIPT_MAX_CHARS = 18_000;
const EXPLORE_SUMMARY_MESSAGE_MAX_CHARS = 2_000;
const EXPLORE_FINAL_SUMMARY_EVIDENCE_MAX_CHARS = 18_000;
const EXPLORE_SUMMARY_MESSAGE_PREFIX = 'Explore summary:';

function readMessageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('');
}

function extractExploreSummaryFromContent(content: string): string | null {
  const normalized = content.replace(/\r\n/g, '\n');
  const markerWithDoubleNewline = `${EXPLORE_SUMMARY_MESSAGE_PREFIX}\n\n`;
  let markerIndex = normalized.lastIndexOf(`\n${markerWithDoubleNewline}`);
  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + markerWithDoubleNewline.length + 1).trim() || null;
  }

  markerIndex = normalized.lastIndexOf(markerWithDoubleNewline);
  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + markerWithDoubleNewline.length).trim() || null;
  }

  return null;
}

function createExploreSummaryMessage(summary: string): AIMessage {
  return new AIMessage({
    id: randomUUID(),
    content: `${EXPLORE_SUMMARY_MESSAGE_PREFIX}\n\n${summary.trim()}`,
  });
}

function readExploreSummary(message: BaseMessage): string | null {
  const content = readMessageText(message);
  if (!content.trim()) {
    return null;
  }

  return extractExploreSummaryFromContent(content);
}

function readLatestExploreSummary(messages: readonly BaseMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const summary = readExploreSummary(messages[index]);
    if (summary) return summary;
  }
  return null;
}

function readLatestSubagentContextSummary(messages: readonly BaseMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.additional_kwargs?.lc_source !== 'summarization') continue;
    const summary = readMessageText(message).trim();
    if (summary) return summary;
  }
  return null;
}

/**
 * Persist the latest explore summary as a report artifact: markdown summary as
 * content, structured evidence ({source, proves, value}[]) in metadata.
 * Record into state via capability finalize so the ref is visible across runs.
 * No-op when the store or addressing context is unavailable.
 */
async function recordExploreIngestArtifact(
  store: CapabilityArtifactStore | undefined,
  sink: CapabilityFinalizeContext | undefined,
  ingest: ExploreKnowledgeIngest,
): Promise<void> {
  if (!store || !sink?.recordCapabilityArtifact || !sink.threadId || !sink.delegationId || !sink.runId) {
    return;
  }
  const normalized = ingest.summary.trim();
  if (!normalized) return;
  const ref = await store.writeArtifact({
    threadId: sink.threadId,
    capabilityId: 'explore',
    delegationId: sink.delegationId,
    runId: sink.runId,
    artifact: {
      kind: 'report',
      mimeType: 'text/markdown',
      title: 'Explore knowledge summary',
      preview: clipForPrompt(normalized, 500),
      content: normalized,
      metadata: { evidence: ingest.evidence },
    },
  });
  await sink.recordCapabilityArtifact(ref);
}

function readMessageStatus(message: BaseMessage): ExploreResult['status'] | null {
  const pinpawo = message.additional_kwargs?.pinpawo;
  if (!pinpawo || typeof pinpawo !== 'object') return null;

  const metadata = pinpawo as Record<string, unknown>;
  if (metadata.announce === 'completed' || metadata.completionReason === 'natural') {
    return 'completed';
  }
  if (metadata.announce === 'progress' || typeof metadata.completionReason === 'string') {
    return 'progress';
  }
  return null;
}

function readLatestStatus(messages: readonly BaseMessage[]): ExploreResult['status'] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const status = readMessageStatus(messages[index]);
    if (status) return status;
  }
  return 'completed';
}

export function readExploreResult(messages: readonly BaseMessage[]): ExploreResult | null {
  const summary = readLatestExploreSummary(messages);
  return summary ? { status: readLatestStatus(messages), summary, nextSteps: [] } : null;
}

async function ingestExploreKnowledge(params: {
  model: BaseChatModel;
  structuredOutput?: OrchestrationDecisionStructuredOutputConfig;
  previousSummary: string | null;
  evidence: string;
}): Promise<ExploreKnowledgeIngest> {
  const evidence = clipForPrompt(params.evidence, EXPLORE_SUMMARY_TRANSCRIPT_MAX_CHARS);
  if (!evidence.trim()) {
    throw new Error('explore ingest has no new evidence');
  }

  const result = await invokeStructuredOutput({
    model: params.model,
    schema: exploreKnowledgeIngestSchema,
    options: {
      name: 'explore_knowledge_ingest',
      ...(params.structuredOutput?.method ? { method: params.structuredOutput.method } : {}),
      ...(typeof params.structuredOutput?.strict === 'boolean' ? { strict: params.structuredOutput.strict } : {}),
      ...(typeof params.structuredOutput?.autoRepair !== 'undefined'
        ? { autoRepair: params.structuredOutput.autoRepair }
        : {}),
    },
    messages: [
      new SystemMessage([
        '你是 explore capability 的知识 ingest 模块。',
        '你会在 explore 执行完成时，把压缩后的执行上下文和近期结果整理成可交付知识。',
        '输入包括上一版 summary 和需要被总结的 evidence。你必须更新 summary，必要时修正旧结论。',
        'summary 必须用 Markdown，包含：目标、已查看文件、关键知识点 / 概念、已确认事实、未确认 / 风险、下一步。',
        'summary 要让下一轮 agent 不重复探索已看过的内容。',
        'evidence 字段：为关键来源各给一条 { source, proves, value }：',
        '- source：参考来源（文件路径、URL、issue/PR 编号、命令输出来源）。',
        '- proves：该来源确认/证明了什么事实。',
        '- value：它对当前推理或下一步的价值。',
        '不要复制大段原始工具输出。',
        '不要编造未查看过的文件、URL、issue、PR 或命令结果。',
      ].join('\n')),
      new HumanMessage([
        '触发原因：finalize',
        '上一版 summary：',
        params.previousSummary ?? '[无]',
        '需要总结的 evidence：',
        evidence,
      ].join('\n\n')),
    ],
  });
  return {
    summary: result.summary.trim(),
    evidence: result.evidence ?? [],
  };
}

function collectAnyToolResultIndexes(messages: BaseMessage[]): number[] {
  return messages
    .map((message, index) => ({ message, index }))
    .filter((item): item is { message: ToolMessage; index: number } => ToolMessage.isInstance(item.message))
    .map((item) => item.index);
}

function buildFinalExploreEvidence(messages: BaseMessage[]): string {
  const toolResultIndexes = collectAnyToolResultIndexes(messages);
  const latestContextSummaryIndex = [...messages.entries()]
    .reverse()
    .find(([, message]) => message.additional_kwargs?.lc_source === 'summarization')?.[0];
  const latestAssistantIndex = [...messages.entries()]
    .reverse()
    .find(([index, message]) => !ToolMessage.isInstance(message) && message._getType() === 'ai' && readMessageText(message))?.[0];

  const priorityIndexes = [
    latestContextSummaryIndex,
    latestAssistantIndex,
    ...toolResultIndexes.reverse(),
  ].filter((index): index is number => index !== undefined);
  if (priorityIndexes.length === 0) {
    return '';
  }

  const selectedEntries = new Map<number, string>();
  let totalLength = 0;
  for (const index of priorityIndexes) {
    if (selectedEntries.has(index)) continue;
    const message = messages[index];
    if (!message) continue;
    const text = readMessageText(message);
    if (!text) continue;

    const entry = [
      ToolMessage.isInstance(message)
        ? `[tool_result] ${typeof message.name === 'string' ? message.name : 'tool'}`
        : `[${message._getType()}] #${index}`,
      clipForPrompt(text, EXPLORE_SUMMARY_MESSAGE_MAX_CHARS),
    ].join('\n');
    if (totalLength + entry.length > EXPLORE_FINAL_SUMMARY_EVIDENCE_MAX_CHARS) continue;
    totalLength += entry.length;
    selectedEntries.set(index, entry);
  }

  const lines = [...selectedEntries.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, entry]) => entry);
  return lines.length > 0 ? `[finalize]\n${lines.join('\n\n')}` : '';
}

async function buildFinalExploreIngest(params: {
  model: BaseChatModel;
  structuredOutput?: OrchestrationDecisionStructuredOutputConfig;
  previousSummary: string | null;
  resultMessages: BaseMessage[];
}): Promise<ExploreKnowledgeIngest | null> {
  const evidence = buildFinalExploreEvidence(params.resultMessages);
  if (!evidence) return null;

  return ingestExploreKnowledge({
    model: params.model,
    structuredOutput: params.structuredOutput,
    previousSummary: params.previousSummary,
    evidence,
  });
}

export function createExploreCapability(options: ExploreCapabilityOptions = {}): AgentCapability {
  return defineCapability({
    name: 'explore',
    description: [
      '通用探索、调查、资料检索和代码库理解 capability。',
      '适合大量阅读、搜索、检查上下文、梳理证据、先探索再决定下一步的任务。',
      '代码 review、代码审查、PR review、pull request review、diff 审查和仓库变更评审也走这个 capability，即使请求里包含 GitHub URL 或网页链接。',
      '只做只读调查和总结，不修改文件、不执行外部真实副作用。',
    ].join(' '),
    uses: options.uses ?? DEFAULT_EXPLORE_TOOLKITS,
    instructions: defineInstructionDocument({
      content: `# Explore

## 目标

只读取、检查、搜索、观察和总结上下文。

## 工作流程

使用可用工具在执行过程中自行规划探索。优先确认候选范围，再读取详细
内容；避免无界浏览或无目的扫描。

代码 review、PR review、pull request review、diff 审查和仓库变更评审
必须优先使用 git Toolkit，尤其是 \`gh_pr_view\`、\`gh_pr_diff\`、
\`git_diff\`、\`git_show\`；不要使用 browser、\`http_fetch\` 或
\`download_file\` 拉取 GitHub PR 页面、diff 或评论。

## 约束与边界

不要修改文件，不要提交、推送、删除、写入、发送消息、发布内容，或执行
任何外部真实副作用。

重要发现必须保留精确来源。运行时可能把较早执行上下文总结为摘要，需要
细节时用 \`view_file\` 等工具按来源回查。

## 输出要求

结论必须包含简洁探索摘要、已查看文件列表、关键发现、证据引用（文件路径、
URL、issue / PR 编号或命令输出来源）和建议下一步。`,
    }),
    lifecycle: {
      finalize: async (result, context) => {
          const ingestModel = context.models.observe ?? context.models.subagent ?? context.models.act;
          const previousSummary = readLatestExploreSummary(context.messages)
            ?? readLatestSubagentContextSummary(context.messages);
          const messagesFromMetadata = result.messages;
          const summaryFromMetadata = readLatestExploreSummary(messagesFromMetadata);
          const contextSummary = readLatestSubagentContextSummary(messagesFromMetadata);
          const ingest = await buildFinalExploreIngest({
              model: ingestModel,
              structuredOutput: options.structuredOutput,
              previousSummary: summaryFromMetadata ?? contextSummary ?? previousSummary,
              resultMessages: messagesFromMetadata,
            }).catch(() => null)
            ?? (summaryFromMetadata || contextSummary
              ? { summary: summaryFromMetadata ?? contextSummary ?? '', evidence: [] }
              : null);

          if (!ingest) {
            return;
          }

          const generatedSummaryMessage = summaryFromMetadata === ingest.summary.trim()
            ? null
            : createExploreSummaryMessage(ingest.summary);
          const nextMessages = generatedSummaryMessage
            ? [...messagesFromMetadata, generatedSummaryMessage]
            : messagesFromMetadata;

          try {
            await recordExploreIngestArtifact(
              context.artifactStore,
              context,
              ingest,
            );
          } catch (error) {
            console.warn(
              `[explore] finalize artifact persistence failed, continuing without crash: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          return {
            messages: nextMessages,
            announceMessageId: result.announceMessageId
              ?? generatedSummaryMessage?.id
              ?? null,
          };
        },
    },
  });
}
