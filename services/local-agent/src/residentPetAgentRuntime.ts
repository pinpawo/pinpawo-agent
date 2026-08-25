/**
 * Resident Pet Agent runtime for local Hosts.
 *
 * 它位于 local-agent 的 Host 层，把 Host 的 dispatch port 接到具体
 * LangGraph 执行路径。Studio 只依赖这个 port 的结构，不参与 Pet 的构造。
 *
 * LangGraph 把 interrupt 与 pending continuation 持久化到 checkpoint；runtime
 * 负责把它投射成公开 PendingInterrupt、校验 typed resume，并构造 Command。
 * Studio core 只搬运这些输入/结果，不解释 review 选项或 checkpoint 内容。
 */
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import {
  isJsonObject,
  parseHumanReviewResponse,
  type JsonObject,
} from '@pinpawo/agent-contracts';

import type { AgentCapability } from '@pinpawo/pet-agent';
import type { AgentActor, AgentModels } from '@pinpawo/pet-agent';
import {
  filterAvailableToolkits,
  type AgentToolkit,
} from '@pinpawo/pet-agent';
import { ToolkitRuntimeManager } from '@pinpawo/pet-agent';
import {
  buildOrchestratorRunInput,
  createOrchestratorGraph,
  compileAgentRegistry,
  formatExecutorCompilationIssues,
  isHumanReviewBatchInterruptPayload,
  isHumanReviewInterruptPayload,
  projectHumanReviewRequest,
  resolveHumanReviewResponse,
  toInternalReviewResponse,
  type OrchestratorConfig,
  type OrchestratorGraph,
  type ReviewResponse,
  type ReviewSpec,
} from '@pinpawo/pet-agent';

/**
 * Local Host owns these Pet runtime semantics. Concrete Hosts (Studio, Chat,
 * or a future transport) consume this object structurally through their own
 * ports; this module deliberately does not import any Host package.
 */
export type ResidentPetAgentStartupMode = 'standby' | 'lazy' | 'disabled';
export type ResidentPetAgentStatus =
  | 'disabled'
  | 'loading'
  | 'standby'
  | 'active'
  | 'degraded'
  | 'unavailable';
export type ResidentPetGateState = 'open' | 'busy' | 'waiting' | 'blocked';
export type ResidentPetAgentCapabilitySummary = {
  name: string;
  description: string;
  available: boolean;
  reason?: string | null;
};
export type ResidentPetContinuation = {
  continuationId: string;
  payload: JsonObject;
};
export type ResidentPetDispatchInput =
  | { kind: 'request'; request: string }
  | { kind: 'resume'; continuationId: string; payload: JsonObject };
export type ResidentPetRuntimeDescriptor = AgentActor & {
  role?: string | null;
  serviceSummary?: string | null;
  startupMode: ResidentPetAgentStartupMode;
  status: ResidentPetAgentStatus;
  capabilities: ResidentPetAgentCapabilitySummary[];
};
export type ResidentPetRuntimeInvokeInput = {
  input: ResidentPetDispatchInput;
  threadId: string;
  signal?: AbortSignal;
};
export type ResidentPetRuntimeInvokeResult =
  | { status: 'completed'; reply: string }
  | { status: 'waiting'; pendingContinuation: ResidentPetContinuation };
export type ResidentPetRuntime = {
  descriptor: () => ResidentPetRuntimeDescriptor;
  invoke: (input: ResidentPetRuntimeInvokeInput) => Promise<ResidentPetRuntimeInvokeResult>;
  gate: () => ResidentPetGateState;
  onGateChange: (listener: (state: ResidentPetGateState) => void) => () => void;
  shutdown?: () => Promise<void>;
};

/**
 * Local runtime allows LangGraph to create durable review interrupts. A Host
 * forwards the opaque projection to its interaction layer and later returns a
 * typed resume dispatch for this Pet thread.
 */
const DEFAULT_PET_REVIEW_CAPABILITIES = {
  humanReview: true,
  sessionAuthorization: true,
} as const;

export type ResidentPetAgentRuntimeConfig = {
  models: AgentModels;
  actor: AgentActor;
  /** Defaults to `general` when the runtime builds its own graph. */
  defaultCapabilityName?: OrchestratorConfig['defaultCapabilityName'];
  role?: string | null;
  serviceSummary?: string | null;
  startupMode?: ResidentPetAgentStartupMode;
  status?: ResidentPetAgentStatus;
  capabilities?: AgentCapability[];
  toolkits?: AgentToolkit[];
  workdir?: string;
  graph?: OrchestratorGraph;
  modelInputModalities?: OrchestratorConfig['modelInputModalities'];
  checkpoint?: OrchestratorConfig['checkpoint'];
  contextWindowTokens?: OrchestratorConfig['contextWindowTokens'];
  generationReserveTokens?: OrchestratorConfig['generationReserveTokens'];
  subagentContextWindowTokens?: OrchestratorConfig['subagentContextWindowTokens'];
  subagentGenerationReserveTokens?: OrchestratorConfig['subagentGenerationReserveTokens'];
  /** Host-owned when a process has a durable Toolkit runtime lifecycle. */
  toolkitRuntimeManager?: ToolkitRuntimeManager;
};

function buildCapabilitySummaries(
  config: ResidentPetAgentRuntimeConfig,
): ResidentPetAgentCapabilitySummary[] {
  // descriptor() is synchronous and therefore reports static dependency
  // resolution against the configured Toolkit inventory. Runtime availability
  // is evaluated for each async invoke generation below.
  const registry = compileAgentRegistry({
    toolkits: config.toolkits ?? [],
    capabilities: config.capabilities ?? [],
  });
  const availableNames = new Set(
    registry.capabilities.map(({ capability }) => capability.name),
  );
  const unavailableByName = new Map(
    registry.unavailableCapabilities.map(({ capability, issues }) => [
      capability.name,
      formatExecutorCompilationIssues(issues),
    ]),
  );
  return (config.capabilities ?? []).map((capability) => {
    const available = availableNames.has(capability.name);
    return {
      name: capability.name,
      description: capability.description,
      available,
      reason: available ? null : unavailableByName.get(capability.name) ?? null,
    };
  });
}

function assertConfiguredDefaultCapability(
  config: ResidentPetAgentRuntimeConfig,
  registry: ReturnType<typeof compileAgentRegistry>,
) {
  const defaultCapabilityName = config.defaultCapabilityName;
  if (defaultCapabilityName === undefined) return;
  const available = registry.capabilities.some(
    ({ capability }) => capability.name === defaultCapabilityName,
  );
  if (available) return;
  const unavailable = registry.unavailableCapabilities.find(
    ({ capability }) => capability.name === defaultCapabilityName,
  );
  const reason = unavailable
    ? `: ${formatExecutorCompilationIssues(unavailable.issues)}`
    : '';
  throw new Error(
    `Pet agent "${config.actor.petId}" default Capability `
    + `"${defaultCapabilityName}" is not available${reason}`,
  );
}

function initialStatus(config: ResidentPetAgentRuntimeConfig): ResidentPetAgentStatus {
  if (config.startupMode === 'disabled') return 'disabled';
  if (config.startupMode === 'lazy') return config.status ?? 'unavailable';
  return config.status ?? 'standby';
}

function canInvokeStatus(status: ResidentPetAgentStatus): boolean {
  return status === 'standby' || status === 'degraded';
}

/**
 * checkpoint 上还有没有没跑完的活。
 *
 * pet 撞到人工确认时 `graph.invoke` 会**提前返回**,但 graph 停在中断点上,
 * `next` / `tasks` 非空。这正是"invoke 返回 ≠ 活干完了"的判据。
 */
function hasPendingContinuation(snapshot: unknown): boolean {
  const record = snapshot && typeof snapshot === 'object'
    ? snapshot as { next?: unknown; tasks?: unknown }
    : null;
  const next = Array.isArray(record?.next) ? record.next : [];
  if (next.length > 0) return true;
  const tasks = Array.isArray(record?.tasks) ? record.tasks : [];
  return tasks.length > 0;
}

type PendingHumanReview = {
  projection: ResidentPetContinuation;
  reviews: ReviewSpec[];
};

function readGraphInterrupt(snapshot: unknown): { id: string; value: unknown } | null {
  const tasks = Array.isArray((snapshot as { tasks?: unknown } | null)?.tasks)
    ? (snapshot as { tasks: unknown[] }).tasks
    : [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const interrupts = Array.isArray((task as { interrupts?: unknown }).interrupts)
      ? (task as { interrupts: unknown[] }).interrupts
      : [];
    const first = interrupts[0];
    if (!first || typeof first !== 'object') continue;
    const id = (first as { id?: unknown }).id;
    if (typeof id !== 'string' || !id) continue;
    return { id, value: (first as { value?: unknown }).value };
  }
  return null;
}

function projectPendingHumanReview(snapshot: unknown): PendingHumanReview | null {
  const interrupt = readGraphInterrupt(snapshot);
  if (!interrupt) return null;
  const reviews = isHumanReviewBatchInterruptPayload(interrupt.value)
    ? interrupt.value.reviews.map((item) => item.review)
    : isHumanReviewInterruptPayload(interrupt.value)
      ? [interrupt.value.review]
      : [];
  if (reviews.length === 0) return null;
  return {
    projection: {
      continuationId: interrupt.id,
      payload: {
        kind: 'human_review',
        interactions: reviews.map(projectHumanReviewRequest),
      },
    },
    reviews,
  };
}

function buildHumanReviewResume(
  pending: PendingHumanReview,
  responses: Parameters<typeof toInternalReviewResponse>[0][],
) {
  const decisions = responses.map(toInternalReviewResponse);
  if (decisions.length === 0 || decisions.length > pending.reviews.length) {
    throw new Error(
      `Continuation "${pending.projection.continuationId}" expects ${pending.reviews.length} review response(s).`,
    );
  }
  for (let index = 0; index < decisions.length; index += 1) {
    const review = pending.reviews[index];
    const decision = decisions[index];
    if (!review || !decision || decision.reviewId !== review.id) {
      throw new Error(
        `Review response at index ${index.toString()} does not match the pending interaction.`,
      );
    }
    const resolution = resolveHumanReviewResponse({ reviewSpec: review }, decision);
    const isFinal = index === decisions.length - 1;
    if (resolution.decision.type !== 'approve' && !isFinal) {
      throw new Error(`Review response "${decision.reviewId}" stops the batch and must be final.`);
    }
    if (
      resolution.decision.type === 'approve'
      && isFinal
      && decisions.length < pending.reviews.length
    ) {
      throw new Error(`Review response batch is incomplete after "${decision.reviewId}".`);
    }
  }
  return { [pending.projection.continuationId]: { decisions: decisions as ReviewResponse[] } };
}

function parseHumanReviewContinuationPayload(
  payload: Record<string, unknown>,
): Parameters<typeof toInternalReviewResponse>[0][] | null {
  if (
    payload.kind !== 'human_review_response'
    || !Array.isArray(payload.responses)
    || payload.responses.length === 0
  ) return null;
  const responses = payload.responses.map(parseHumanReviewResponse);
  return responses.some((response) => response === null)
    ? null
    : responses as Parameters<typeof toInternalReviewResponse>[0][];
}

export function createResidentPetAgentRuntime(
  config: ResidentPetAgentRuntimeConfig,
): ResidentPetRuntime {
  if (config.defaultCapabilityName !== undefined) {
    assertConfiguredDefaultCapability(config, compileAgentRegistry({
      toolkits: config.toolkits ?? [],
      capabilities: config.capabilities ?? [],
    }));
  }
  let status = initialStatus(config);
  let gateState: ResidentPetGateState = 'open';
  const gateListeners = new Set<(state: ResidentPetGateState) => void>();

  function setGate(next: ResidentPetGateState): void {
    if (gateState === next) return;
    gateState = next;
    for (const listener of gateListeners) {
      try {
        listener(next);
      } catch (error) {
        console.error(
          '[pet-runtime] gate listener failed:',
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
  const startupMode = config.startupMode ?? 'standby';
  // A caller-supplied graph is already responsible for its graph config. Do
  // not create and start an unreachable manager beside it.
  const ownsToolkitRuntimeManager = !config.toolkitRuntimeManager && !config.graph;
  const toolkitRuntimeManager = config.toolkitRuntimeManager
    ?? (config.graph ? null : new ToolkitRuntimeManager());
  const graph = config.graph ?? createOrchestratorGraph({
    models: config.models,
    defaultCapabilityName: config.defaultCapabilityName,
    modelInputModalities: config.modelInputModalities,
    actor: config.actor,
    checkpoint: config.checkpoint,
    contextWindowTokens: config.contextWindowTokens,
    generationReserveTokens: config.generationReserveTokens,
    subagentContextWindowTokens: config.subagentContextWindowTokens,
    subagentGenerationReserveTokens: config.subagentGenerationReserveTokens,
    toolkitRuntimeManager: toolkitRuntimeManager ?? undefined,
  });

  function descriptor(): ResidentPetRuntimeDescriptor {
    return {
      ...config.actor,
      role: config.role ?? null,
      serviceSummary: config.serviceSummary ?? null,
      startupMode,
      status,
      capabilities: buildCapabilitySummaries(config),
    };
  }

  async function invoke(input: ResidentPetRuntimeInvokeInput): Promise<ResidentPetRuntimeInvokeResult> {
    if (startupMode === 'disabled' || !canInvokeStatus(status)) {
      throw new Error(`Pet agent "${config.actor.petId}" is not dispatchable: ${status}`);
    }

    const checkpointConfigurable: Record<string, unknown> = {
      actor: config.actor,
      thread_id: input.threadId,
    };
    const initialSnapshot = config.checkpoint
      ? await graph.getState({ configurable: checkpointConfigurable })
      : null;
    const pending = projectPendingHumanReview(initialSnapshot);
    setGate(pending
      ? 'waiting'
      : hasPendingContinuation(initialSnapshot)
        ? 'blocked'
        : 'open');
    let graphInput: Parameters<OrchestratorGraph['invoke']>[0];
    if (input.input.kind === 'request') {
      if (hasPendingContinuation(initialSnapshot)) {
        setGate(pending ? 'waiting' : 'blocked');
        throw new Error(
          pending
            ? `Pet "${config.actor.petId}" is waiting on continuation "${pending.projection.continuationId}".`
            : `Pet "${config.actor.petId}" has an unsupported pending continuation.`,
        );
      }
      graphInput = buildOrchestratorRunInput(
        [new HumanMessage(input.input.request)],
      );
    } else {
      if (!pending) {
        setGate(hasPendingContinuation(initialSnapshot) ? 'blocked' : 'open');
        throw new Error(`Pet "${config.actor.petId}" has no resumable continuation.`);
      }
      if (pending.projection.continuationId !== input.input.continuationId) {
        setGate('waiting');
        throw new Error(
          `Continuation "${input.input.continuationId}" is stale; `
          + `Pet "${config.actor.petId}" is waiting on "${pending.projection.continuationId}".`,
        );
      }
      if (!isJsonObject(input.input.payload)) {
        setGate('waiting');
        throw new Error(`Continuation "${input.input.continuationId}" received an unsupported payload.`);
      }
      const responses = parseHumanReviewContinuationPayload(input.input.payload);
      if (!responses) {
        setGate('waiting');
        throw new Error(`Continuation "${input.input.continuationId}" received an unsupported payload.`);
      }
      graphInput = new Command({
        resume: buildHumanReviewResume(pending, responses),
      });
    }

    const toolkitDefinitions = config.toolkits ?? [];
    await toolkitRuntimeManager?.start(toolkitDefinitions, { signal: input.signal });
    const toolkits = await filterAvailableToolkits(toolkitDefinitions);
    const registry = compileAgentRegistry({
      toolkits,
      capabilities: config.capabilities ?? [],
    });
    assertConfiguredDefaultCapability(config, registry);
    const configurable: Record<string, unknown> = {
      actor: config.actor,
      thread_id: input.threadId,
      registry,
      reviewCapabilities: DEFAULT_PET_REVIEW_CAPABILITIES,
      execution: {
        threadId: input.threadId,
      },
      workdir: config.workdir,
    };

    const previousStatus = status;
    status = 'active';
    setGate('busy');
    try {
      const result = await graph.invoke(graphInput, { signal: input.signal, configurable });
      const finalSnapshot = config.checkpoint
        ? await graph.getState({ configurable })
        : null;
      const finalPending = projectPendingHumanReview(finalSnapshot);
      if (finalPending) {
        setGate('waiting');
        return {
          status: 'waiting',
          pendingContinuation: finalPending.projection,
        };
      }
      if (hasPendingContinuation(finalSnapshot)) {
        setGate('blocked');
        throw new Error(
          `Pet "${config.actor.petId}" stopped on an unsupported pending continuation.`,
        );
      }
      setGate('open');
      return { status: 'completed', reply: readReply(result) };
    } catch (error) {
      // An invocation can fail after LangGraph has persisted an interrupt
      // (for example because its caller was cancelled). The checkpoint, not
      // the thrown error, is authoritative for whether this Pet is still
      // waiting on a resumable continuation.
      const recoverySnapshot = config.checkpoint
        ? await graph.getState({ configurable }).catch(() => null)
        : null;
      const recoveryPending = projectPendingHumanReview(recoverySnapshot);
      setGate(recoveryPending ? 'waiting' : 'blocked');
      throw error;
    } finally {
      status = previousStatus === 'active' ? 'standby' : previousStatus;
    }
  }

  return {
    descriptor,
    invoke,
    gate: () => gateState,
    onGateChange: (listener) => {
      gateListeners.add(listener);
      return () => gateListeners.delete(listener);
    },
    shutdown: async () => {
      if (ownsToolkitRuntimeManager && toolkitRuntimeManager) {
        await toolkitRuntimeManager.stop();
      }
    },
  };
}

function readReply(result: unknown): string {
  const messages = (result as { messages?: BaseMessage[] } | undefined)?.messages ?? [];
  const last = messages.at(-1);
  return typeof last?.content === 'string' ? last.content.trim() : '';
}
