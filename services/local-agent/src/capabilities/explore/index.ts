import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { clipForPrompt, invokeStructuredOutput } from '@pinpawo/pet-agent';
import type {
  AgentCapability,
  CapabilityArtifactSink,
  CapabilityArtifactStore,
  ContextPolicyContext,
  OrchestrationDecisionStructuredOutputConfig,
} from '@pinpawo/pet-agent';
import { z } from 'zod';

const DEFAULT_EXPLORE_TOOLKITS = [
  'bash',
  'browser',
  'github',
  'gmail',
] as const;

export type ExploreResult = {
  status: 'progress' | 'completed';
  summary: string;
  nextSteps: string[];
};

export type ExploreCapabilityOptions = {
  structuredOutput?: OrchestrationDecisionStructuredOutputConfig;
};

export const exploreResultSchema = z.object({
  status: z.enum(['progress', 'completed']),
  summary: z.string().min(1),
  nextSteps: z.array(z.string().min(1)),
});

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

const EXPLORE_CONTEXT_COMPRESSION_RATIO = 0.75;
const EXPLORE_FALLBACK_COMPRESSION_BUDGET_TOKENS = 24_000;
const EXPLORE_COMPRESS_KEEP_RECENT_TOOL_RESULTS = 2;
const EXPLORE_COMPRESS_MIN_TOOL_CHARS = 800;
const EXPLORE_SUMMARY_TRANSCRIPT_MAX_CHARS = 18_000;
const EXPLORE_SUMMARY_MESSAGE_MAX_CHARS = 2_000;
const EXPLORE_RAW_EVICTED = '[explore raw tool output evicted after ingest]';

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

function readPinpawoMetadata(message: BaseMessage): Record<string, unknown> | null {
  const pinpawo = message.additional_kwargs?.pinpawo;
  return pinpawo && typeof pinpawo === 'object'
    ? pinpawo as Record<string, unknown>
    : null;
}

function mergePinpawoMetadata(
  message: BaseMessage,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(message.additional_kwargs?.pinpawo && typeof message.additional_kwargs.pinpawo === 'object'
      ? message.additional_kwargs.pinpawo as Record<string, unknown>
      : {}),
    ...patch,
  };
}

function readExploreSummary(message: BaseMessage): string | null {
  const summary = readPinpawoMetadata(message)?.exploreSummary;
  return typeof summary === 'string' && summary.trim() ? summary.trim() : null;
}

function readLatestExploreSummary(messages: BaseMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const metadata = readPinpawoMetadata(messages[index]);
    if (metadata?.exploreIngestFailed === true) return null;
    const summary = readExploreSummary(messages[index]);
    if (summary) return summary;
  }
  return null;
}

/**
 * Persist a context-pressure ingest as a single report artifact: the markdown
 * summary as content, the structured evidence ({source, proves, value}[]) in
 * metadata. Recorded into state via the subagent's artifact sink so the ref is
 * visible across turns (avoids re-exploring; redesign §14). No-op when the
 * store, sink, or threadId is unavailable (tests / degraded runtimes / explore
 * surfaces without a store such as studio).
 */
async function recordExploreIngestArtifact(
  store: CapabilityArtifactStore | undefined,
  sink: CapabilityArtifactSink | undefined,
  ingest: ExploreKnowledgeIngest,
): Promise<void> {
  if (!store || !sink?.recordCapabilityArtifact || !sink.threadId || !sink.delegationId || !sink.turnId) {
    return;
  }
  const normalized = ingest.summary.trim();
  const ref = await store.writeArtifact({
    threadId: sink.threadId,
    capabilityId: 'explore',
    delegationId: sink.delegationId,
    turnId: sink.turnId,
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

function readLatestStatus(messages: BaseMessage[]): ExploreResult['status'] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const status = readMessageStatus(messages[index]);
    if (status) return status;
  }
  return 'completed';
}

export function readExploreResult(messages: BaseMessage[]): ExploreResult | null {
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
        '当探索的上下文接近预算上限时，你被调用来对较早的探索内容做一次完整总结，',
        '使较早的原始工具输出可以从上下文中移除，只保留你的总结和最新若干条原文。',
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
        '触发原因：context_pressure',
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

function replaceToolMessageContent(
  message: ToolMessage,
  content: string,
  pinpawoPatch: Record<string, unknown> = {},
): ToolMessage {
  return new ToolMessage({
    id: message.id,
    name: message.name,
    content,
    tool_call_id: message.tool_call_id,
    status: message.status,
    artifact: message.artifact,
    metadata: message.metadata,
    additional_kwargs: {
      ...message.additional_kwargs,
      pinpawo: mergePinpawoMetadata(message, pinpawoPatch),
    },
    response_metadata: message.response_metadata,
  });
}

function buildExploreCompressionBudget(ctx: ContextPolicyContext): number {
  const contextWindowTokens = ctx.contextWindowTokens;
  if (contextWindowTokens && Number.isFinite(contextWindowTokens) && contextWindowTokens > 0) {
    return Math.max(1, Math.floor(contextWindowTokens * EXPLORE_CONTEXT_COMPRESSION_RATIO));
  }
  return EXPLORE_FALLBACK_COMPRESSION_BUDGET_TOKENS;
}

function isCompressedExploreToolOutput(message: ToolMessage) {
  return readPinpawoMetadata(message)?.exploreRawEvicted === true;
}

function collectCompressibleToolResultIndexes(messages: BaseMessage[]): number[] {
  const toolIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter((item): item is { message: ToolMessage; index: number } => ToolMessage.isInstance(item.message));
  const protectedIndexes = new Set(
    toolIndexes.slice(-EXPLORE_COMPRESS_KEEP_RECENT_TOOL_RESULTS).map((item) => item.index),
  );

  return toolIndexes
    .filter(({ message, index }) => {
      if (protectedIndexes.has(index)) return false;
      if (message.status === 'error') return false;
      const text = readMessageText(message);
      if (isCompressedExploreToolOutput(message)) return false;
      return text.length >= EXPLORE_COMPRESS_MIN_TOOL_CHARS;
    })
    .map((item) => item.index);
}

/**
 * Builds the evidence string the summarizer sees, and returns the exact set of
 * tool-output indexes that string actually covers. Only those covered indexes
 * may be evicted afterwards — outputs dropped by the char-budget `break` were
 * never shown to the summarizer, so evicting them would lose findings silently
 * (review finding #3).
 */
function buildContextPressureEvidence(messages: BaseMessage[], toolIndexes: number[]) {
  const selected = new Set(toolIndexes);
  const lines: string[] = [];
  const coveredIndexes: number[] = [];
  let totalLength = 0;

  for (const [index, message] of messages.entries()) {
    if (!selected.has(index)) continue;
    const text = readMessageText(message);
    if (!text) continue;
    const entry = [
      `[tool_result] ${typeof (message as ToolMessage).name === 'string' ? (message as ToolMessage).name : 'tool'}`,
      clipForPrompt(text, EXPLORE_SUMMARY_MESSAGE_MAX_CHARS),
    ].join('\n');
    totalLength += entry.length;
    if (totalLength > EXPLORE_SUMMARY_TRANSCRIPT_MAX_CHARS) break;
    lines.push(entry);
    coveredIndexes.push(index);
  }

  return {
    evidence: lines.length > 0 ? `[context_pressure]\n${lines.join('\n\n')}` : '',
    coveredIndexes,
  };
}

function replaceCompressedToolOutputs(
  messages: BaseMessage[],
  toolIndexes: number[],
  summary: string,
): BaseMessage[] {
  if (toolIndexes.length === 0) return messages;
  const summaryIndex = toolIndexes[toolIndexes.length - 1];
  const selected = new Set(toolIndexes);
  return messages.map((message, index) => {
    if (!selected.has(index) || !ToolMessage.isInstance(message)) return message;
    const content = index === summaryIndex
      ? `${EXPLORE_RAW_EVICTED}\n\nExplore summary:\n\n${summary.trim()}`
      : `${EXPLORE_RAW_EVICTED}\nSee the later compressed explore summary for findings.`;
    return replaceToolMessageContent(message, content, {
      exploreRawEvicted: true,
      ...(index === summaryIndex ? { exploreSummary: summary.trim() } : {}),
    });
  });
}

export function createExploreCapability(options: ExploreCapabilityOptions = {}): AgentCapability {
  return {
    name: 'explore',
    description: [
      '通用探索、调查、资料检索和代码库理解 capability。',
      '适合大量阅读、搜索、检查上下文、梳理证据、先探索再决定下一步的任务。',
      '只做只读调查和总结，不修改文件、不执行外部真实副作用。',
    ].join(' '),
    createRuntime: async (context) => {
      const available = new Set(context.availableToolkits?.map((item) => item.name) ?? []);
      const ingestModel = context.models.observe ?? context.models.subagent ?? context.models.act;
      const artifactStore = context.artifactStore;
      let currentSummary = readLatestExploreSummary(context.messages);
      const rewriteUnderContextPressure = async (
        messages: BaseMessage[],
        ctx: ContextPolicyContext,
      ): Promise<BaseMessage[]> => {
        const budgetTokens = buildExploreCompressionBudget(ctx);
        if (ctx.estimateMessagesTokens(messages) <= budgetTokens) {
          return messages;
        }
        const toolIndexes = collectCompressibleToolResultIndexes(messages);
        if (toolIndexes.length === 0) {
          return messages;
        }
        const { evidence, coveredIndexes } = buildContextPressureEvidence(messages, toolIndexes);
        if (!evidence.trim() || coveredIndexes.length === 0) {
          return messages;
        }
        // Summarizing + persisting must never crash the explore run: an ingest
        // model error (rate limit, timeout, structured-output parse failure) or a
        // store write failure under context pressure should degrade to "keep the
        // raw outputs this round", not abort the whole turn (review finding #1).
        try {
          const ingest = await ingestExploreKnowledge({
            model: ingestModel,
            structuredOutput: options.structuredOutput,
            previousSummary: currentSummary,
            evidence,
          });
          // Persist the summary + structured evidence as a report artifact so the
          // earlier raw outputs can be dropped from context yet remain recallable.
          // Record + evict before advancing currentSummary so a persistence
          // failure leaves summary/context consistent (review finding #2).
          await recordExploreIngestArtifact(artifactStore, ctx.artifactSink, ingest);
          // Only evict the outputs the summarizer actually saw (finding #3).
          const rewritten = replaceCompressedToolOutputs(messages, coveredIndexes, ingest.summary);
          currentSummary = ingest.summary;
          return rewritten;
        } catch (error) {
          console.warn(
            `[explore] context-pressure ingest failed, keeping raw outputs this round: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return messages;
        }
      };
      return {
        uses: DEFAULT_EXPLORE_TOOLKITS.filter((name) => available.has(name)),
        contextPolicy: {
          rewriteAsync: rewriteUnderContextPressure,
        },
        instructions: [
          '你是通用探索 capability。只读取、检查、搜索、观察和总结上下文。',
          '不要修改文件，不要提交、推送、删除、写入、发送消息、发布内容，或执行任何外部真实副作用。',
          '使用可用工具在执行过程中自行规划探索；createRuntime 阶段不做额外模型规划。',
          '优先先确认候选范围，再读取详细内容；避免无界浏览或无目的扫描。',
          '上下文足够时会保留完整工具输出；只有接近上下文预算时，较早的大型工具输出才会被知识摘要替换并沉淀为知识 artifact。摘要会写明来源，需要细节时用 view_file 等工具按来源回查。',
          '结论必须包含简洁探索摘要、已查看文件列表、关键发现、证据引用（文件路径、URL、issue/PR 编号或命令输出来源）和建议下一步。',
        ],
      };
    },
    resultSchema: exploreResultSchema,
  };
}
