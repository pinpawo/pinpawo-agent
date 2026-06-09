import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AgentCapability, CapabilityAvailability } from '../../types/capability';
import type { AgentActor, AgentExecution, AgentModels } from '../../types/agent';
import type { AgentToolkit } from '../../types/toolkit';
import type {
  PetAgentCapabilitySummary,
  PetAgentStartupMode,
  PetAgentStatus,
} from '../../types/studio';
import {
  buildOrchestratorTurnInput,
  createOrchestratorGraph,
  type OrchestratorConfig,
  type OrchestratorGraph,
} from '../createAgentRuntime';
import { buildHumanReviewResume } from '../orchestrator/humanReview';
import type {
  HumanReviewer,
  HumanReviewerRequest,
  PetAgentRuntime,
  PetAgentRuntimeDescriptor,
  PetAgentRuntimeInvokeInput,
  PetAgentRuntimeInvokeResult,
} from './types';
import { createWikiReadToolkit } from './wikiReadToolkit';

export type PetAgentRuntimeConfig = {
  models: AgentModels;
  actor: AgentActor;
  role?: string | null;
  serviceSummary?: string | null;
  startupMode?: PetAgentStartupMode;
  status?: PetAgentStatus;
  capabilities?: AgentCapability[];
  capabilityAvailability?: Record<string, CapabilityAvailability>;
  toolkits?: AgentToolkit[];
  execution?: AgentExecution;
  workdir?: string;
  /**
   * HITL 应答桥。pet runtime 在 invoke 期间撞到 interrupt 时调用,
   * 拿到 decision 后续跑 graph。不提供时 pet 不应触发 HITL tool;
   * 若仍触发 interrupt,invoke 将抛错。
   */
  humanReviewer?: HumanReviewer;
  graph?: OrchestratorGraph;
  checkpoint?: OrchestratorConfig['checkpoint'];
  decisionStructuredOutput?: OrchestratorConfig['decisionStructuredOutput'];
  contextWindowTokens?: OrchestratorConfig['contextWindowTokens'];
};

function buildCapabilitySummaries(config: PetAgentRuntimeConfig): PetAgentCapabilitySummary[] {
  return (config.capabilities ?? []).map((capability) => {
    const availability = config.capabilityAvailability?.[capability.name];
    return {
      name: capability.name,
      description: capability.description,
      available: availability?.available ?? true,
      reason: availability?.reason ?? null,
    };
  });
}

function initialStatus(config: PetAgentRuntimeConfig): PetAgentStatus {
  if (config.startupMode === 'disabled') return 'disabled';
  if (config.startupMode === 'lazy') return config.status ?? 'unavailable';
  return config.status ?? 'standby';
}

function canInvokeStatus(status: PetAgentStatus): boolean {
  return status === 'standby' || status === 'degraded';
}

/**
 * Wiki middleware:读取 {wikiRoot}/index.md 并构造 system prompt 片段。
 * 缺失或读不到则降级为只列目录路径,不抛错。
 */
async function buildWikiSystemPrompt(wikiRoot: string): Promise<string> {
  const indexPath = path.join(wikiRoot, 'index.md');
  let indexContent: string;
  try {
    indexContent = await fs.readFile(indexPath, 'utf8');
  } catch {
    indexContent = '(知识库为空,尚未生成 index.md)';
  }
  return [
    '你可以访问一个共享知识库,根目录已通过 wiki_read 工具配置好。',
    '下面是知识库的当前索引:',
    '',
    '----- index.md -----',
    indexContent.trim(),
    '--------------------',
    '',
    '使用 wiki_read_ls / wiki_read_cat / wiki_read_grep / wiki_read_find / wiki_read_head / wiki_read_tail 检索详情。',
  ].join('\n');
}

async function buildInvokeMessages(brief: string, wikiRoot: string | undefined): Promise<BaseMessage[]> {
  const messages: BaseMessage[] = [];
  if (wikiRoot) {
    const wikiPrompt = await buildWikiSystemPrompt(wikiRoot);
    messages.push(new SystemMessage(wikiPrompt));
  }
  messages.push(new HumanMessage(brief));
  return messages;
}

export function createPetAgentRuntime(config: PetAgentRuntimeConfig): PetAgentRuntime {
  let status = initialStatus(config);
  const startupMode = config.startupMode ?? 'standby';
  const graph = config.graph ?? createOrchestratorGraph({
    models: config.models,
    actor: config.actor,
    checkpoint: config.checkpoint,
    decisionStructuredOutput: config.decisionStructuredOutput,
    contextWindowTokens: config.contextWindowTokens,
  });

  function descriptor(): PetAgentRuntimeDescriptor {
    return {
      ...config.actor,
      role: config.role ?? null,
      serviceSummary: config.serviceSummary ?? null,
      startupMode,
      status,
      capabilities: buildCapabilitySummaries(config),
    };
  }

  async function invoke(input: PetAgentRuntimeInvokeInput): Promise<PetAgentRuntimeInvokeResult> {
    if (startupMode === 'disabled' || !canInvokeStatus(status)) {
      throw new Error(`Pet agent "${config.actor.petId}" is not dispatchable: ${status}`);
    }

    const messages = await buildInvokeMessages(input.brief, input.wikiRoot);
    const toolkits = [
      ...(config.toolkits ?? []),
      ...(input.toolkits ?? []),
      ...(input.wikiRoot ? [createWikiReadToolkit(input.wikiRoot)] : []),
    ];
    const configurable: Record<string, unknown> = {
      actor: config.actor,
      thread_id: input.threadId,
      capabilities: [...(config.capabilities ?? []), ...(input.extraCapabilities ?? [])],
      toolkits,
      execution: input.execution ?? config.execution,
      workdir: input.workdir ?? config.workdir,
      runtimeEnvironment: input.runtimeEnvironment,
      onToolEvent: input.onToolEvent,
      forcedCapabilityNames: input.forcedCapabilityNames,
    };

    const previousStatus = status;
    status = 'active';
    try {
      let graphInput: Parameters<OrchestratorGraph['invoke']>[0] = buildOrchestratorTurnInput(messages);
      while (true) {
        const result = await graph.invoke(graphInput, { signal: input.signal, configurable });
        const pending = readPendingInterrupt(result);
        if (!pending) {
          return { reply: readReply(result) };
        }
        if (!config.humanReviewer) {
          throw new Error(
            `Pet agent "${config.actor.petId}" hit HITL interrupt but no humanReviewer configured`,
          );
        }
        const decision = await config.humanReviewer(pending);
        graphInput = new Command({ resume: buildHumanReviewResume([decision]) });
      }
    } finally {
      status = previousStatus === 'active' ? 'standby' : previousStatus;
    }
  }

  return {
    descriptor,
    invoke,
  };
}

function readReply(result: unknown): string {
  const messages = (result as { messages?: BaseMessage[] } | undefined)?.messages ?? [];
  const last = messages.at(-1);
  return typeof last?.content === 'string' ? last.content.trim() : '';
}

function readPendingInterrupt(result: unknown): HumanReviewerRequest | undefined {
  const raw = (result as { __interrupt__?: unknown } | undefined)?.__interrupt__;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const first = raw[0];
  const value = first && typeof first === 'object' && 'value' in first
    ? (first as { value?: unknown }).value
    : null;
  if (!value || typeof value !== 'object') return undefined;
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== 'review') return undefined;
  return value as HumanReviewerRequest;
}
