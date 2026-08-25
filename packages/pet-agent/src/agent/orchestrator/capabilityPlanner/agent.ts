import {
  HumanMessage,
  RemoveMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredTool } from '@langchain/core/tools';
import { randomUUID } from 'node:crypto';
import { createAgent } from 'langchain';
import {
  createCapabilityPlannerFileExplorer,
  type CapabilityPlannerCapabilityDocument,
  type CapabilityPlannerFileExplorer,
} from './fileExplorer';
import type { CapabilityRegistryBackend } from './registryDocuments';
import { buildCapabilityPlannerAgentInput } from '../prompts/capabilityPlannerAgent';
import type {
  CapabilityPlannerInput,
  CapabilityPlannerResult,
  CapabilityPlannerRunner,
} from './runner';
import { parsePlannerCommit } from './protocol';
import {
  CAPABILITY_PLANNER_MESSAGE_SOURCE,
  isCapabilityPlannerMessage,
  projectCapabilityPlannerMessagesForModel,
  selectCapabilityPlannerMessages,
} from './messageContext';
import {
  getPinpetMeta,
  setPinpetMeta,
  stampMessageCreatedAtUtc,
} from '../messageLanes';
import { createPlannerMiddleware } from './plannerMiddleware';
import { plannerCommitContext } from './plannerState';
import {
  applyCapabilitySearchObservations,
  removeSearchedCapabilities,
} from './capabilityDisclosure';
import {
  createPlannerCapabilitySearchTool,
  createPlannerSearchStateMiddleware,
} from './searchTool';
import { createPlannerTerminalTools } from './terminalTools';
import { PlannerFileToolError } from './workspaceReader';

const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_CAPABILITY_PLANNER_MAX_SEARCH_ROUNDS = 2;

export type CapabilityPlannerAgentErrorCode =
  | 'planning_limit_reached'
  | 'planning_timeout';

export class CapabilityPlannerAgentError extends Error {
  readonly code: CapabilityPlannerAgentErrorCode;

  constructor(code: CapabilityPlannerAgentErrorCode, message: string) {
    super(message);
    this.name = 'CapabilityPlannerAgentError';
    this.code = code;
  }
}

function readTerminalCommit(message: ToolMessage): unknown {
  if (message.status === 'error' || typeof message.content !== 'string') {
    return null;
  }
  try {
    return JSON.parse(message.content);
  } catch {
    return null;
  }
}

function mergePlannerSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
) {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);
  return {
    signal: parentSignal
      ? AbortSignal.any([parentSignal, timeoutController.signal])
      : timeoutController.signal,
    didTimeOut: () => timedOut,
    dispose: () => clearTimeout(timeout),
  };
}

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

/**
 * Stamp Planner-lane provenance onto a message, in place.
 *
 * Callers must only pass messages this invocation produced. The `produced`
 * filter in buildPlannerMessageUpdates() is what guarantees that: it drops any
 * message still referenced by, or sharing an id with, `input.messages`, so a
 * message already committed to root state is never mutated here.
 */
function stampPlannerMessage(params: {
  message: BaseMessage;
  input: CapabilityPlannerInput;
}) {
  const { message, input } = params;
  if (!message.id) message.id = randomUUID();
  stampMessageCreatedAtUtc(message);
  setPinpetMeta(message, {
    lane: 'orchestrator',
    source: CAPABILITY_PLANNER_MESSAGE_SOURCE,
    traceId: input.traceId,
    runId: input.runId,
    plannerInputId: input.inputId,
    registryDigest: input.workspace.registryDigest,
  });
  return message;
}

function readCachedPlannerCommit(input: CapabilityPlannerInput) {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    const meta = getPinpetMeta(message);
    if (!ToolMessage.isInstance(message)
      || !isCapabilityPlannerMessage(message, input.traceId)
      || meta.registryDigest !== input.workspace.registryDigest
      || meta.plannerInputId !== input.inputId) {
      continue;
    }
    const rawCommit = readTerminalCommit(message);
    if (rawCommit) return rawCommit;
  }
  return null;
}

function buildPlannerMessageUpdates(params: {
  input: CapabilityPlannerInput;
  resultMessages: readonly BaseMessage[];
}) {
  const rootRefs = new Set(params.input.messages);
  const rootIds = new Set(params.input.messages.flatMap((message) =>
    message.id ? [message.id] : [],
  ));
  const produced = params.resultMessages.filter((message) =>
    !rootRefs.has(message) && (!message.id || !rootIds.has(message.id)),
  );
  const stalePlannerRemovals = params.input.messages.flatMap((message) => {
    if (!isCapabilityPlannerMessage(message)) return [];
    const meta = getPinpetMeta(message);
    if (meta.traceId === params.input.traceId
      && meta.registryDigest === params.input.workspace.registryDigest) {
      return [];
    }
    return message.id ? [new RemoveMessage({ id: message.id }) as BaseMessage] : [];
  });
  return [
    ...stalePlannerRemovals,
    ...produced.map((message) => stampPlannerMessage({ message, input: params.input })),
  ];
}

function buildPlannerRunnableConfig(params: {
  input: CapabilityPlannerInput;
  runnableConfig?: RunnableConfig;
  signal: AbortSignal;
}): RunnableConfig {
  return {
    ...params.runnableConfig,
    signal: params.signal,
    runName: 'framework.capability_planner',
    tags: [
      ...(params.runnableConfig?.tags ?? []),
      'framework.capability_planner',
    ],
    metadata: {
      ...(params.runnableConfig?.metadata ?? {}),
      frameworkComponent: 'capability_planner',
      traceId: params.input.traceId,
      runId: params.input.runId,
      plannerInputId: params.input.inputId,
      registryDigest: params.input.workspace.registryDigest,
      plannerMode: params.input.mode,
    },
  };
}

export function createCapabilityPlannerAgent(params: {
  model: BaseChatModel;
  /** Capability preloaded as the entry Planner's default candidate. */
  defaultCapabilityName?: string;
  timeoutMs?: number;
  registryBackend?: CapabilityRegistryBackend;
  maxDocumentReadBytes?: number;
  /** Additional invocation-scoped Planner tools. */
  additionalTools?: StructuredTool[];
}): CapabilityPlannerRunner {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertPositiveInteger(timeoutMs, 'Capability Planner timeoutMs');
  if (params.maxDocumentReadBytes !== undefined) {
    assertPositiveInteger(
      params.maxDocumentReadBytes,
      'Capability Planner maxDocumentReadBytes',
    );
  }
  const explorers = new Map<string, CapabilityPlannerFileExplorer>();
  const explorerForInput = (input: CapabilityPlannerInput) => {
    const existing = explorers.get(input.inputId);
    if (existing) return existing;
    const explorer = createCapabilityPlannerFileExplorer({
      workspace: input.workspace,
      ...(params.defaultCapabilityName !== undefined
        ? { defaultCapabilityName: params.defaultCapabilityName }
        : {}),
      registryBackend: params.registryBackend ?? 'filesystem',
      ...(params.maxDocumentReadBytes
        ? { maxDocumentReadBytes: params.maxDocumentReadBytes }
        : {}),
    });
    explorers.set(input.inputId, explorer);
    return explorer;
  };
  const terminalTools = createPlannerTerminalTools();
  const additionalTools = params.additionalTools ?? [];
  const capabilitySearchTool = createPlannerCapabilitySearchTool({
    explorerForInput,
  });
  const middleware = createPlannerMiddleware();
  const agent = createAgent({
    name: 'capabilityPlanner',
    model: params.model,
    tools: [capabilitySearchTool, ...terminalTools, ...additionalTools],
    systemPrompt: '',
    middleware: [middleware, createPlannerSearchStateMiddleware()],
    checkpointer: false,
  });

  return Object.freeze({
    async invoke(
      input: CapabilityPlannerInput,
      runnableConfig?: RunnableConfig,
    ): Promise<CapabilityPlannerResult> {
      const timeout = mergePlannerSignal(runnableConfig?.signal, timeoutMs);
      const config = buildPlannerRunnableConfig({
        input,
        runnableConfig,
        signal: timeout.signal,
      });
      try {
        timeout.signal.throwIfAborted();
        const cachedCommit = readCachedPlannerCommit(input);
        if (cachedCommit) {
          return {
            ...parsePlannerCommit(cachedCommit, plannerCommitContext(input)),
            capabilityDisclosure: input.capabilityDisclosure,
          };
        }
        let effectiveInput = input;
        let explorer = explorerForInput(effectiveInput);
        let disclosedCapabilities: CapabilityPlannerCapabilityDocument[];
        try {
          disclosedCapabilities = await explorer.readCapabilities(
            effectiveInput.capabilityDisclosure.disclosedCapabilityNames,
            timeout.signal,
          );
        } catch (error) {
          if (!(error instanceof PlannerFileToolError)
            || error.code !== 'planning_limit_reached') {
            throw error;
          }
          effectiveInput = {
            ...input,
            capabilityDisclosure: removeSearchedCapabilities({
              current: input.capabilityDisclosure,
              workspace: input.workspace,
            }),
          };
          // The failed explorer has already marked its budget as exhausted.
          // Recreate it so the configured default and any later search use a
          // clean invocation budget after oversized disclosures are discarded.
          explorers.delete(input.inputId);
          explorer = explorerForInput(effectiveInput);
          disclosedCapabilities = await explorer.readCapabilities(
            effectiveInput.capabilityDisclosure.disclosedCapabilityNames,
            timeout.signal,
          );
        }
        const selectedMessages = input.mode === 'boundary'
          ? selectCapabilityPlannerMessages({
              mode: 'boundary',
              messages: input.messages,
              traceId: input.traceId,
              registryDigest: input.workspace.registryDigest,
              lane: `capability:${input.activeDelegation.capability}`,
              transcriptRunId: input.activeDelegation.transcriptRunId,
              delegationId: input.activeDelegation.delegationId,
              announceMessageId: input.latestAnnounce?.messageId ?? null,
            })
          : selectCapabilityPlannerMessages({
              mode: 'entry',
              messages: input.messages,
              traceId: input.traceId,
              registryDigest: input.workspace.registryDigest,
            });
        const result = await agent.invoke({
          messages: [
            ...projectCapabilityPlannerMessagesForModel(selectedMessages, input),
            new HumanMessage({
              id: `planner:${input.inputId}`,
              content: buildCapabilityPlannerAgentInput(
                effectiveInput,
                disclosedCapabilities,
              ),
            }),
          ],
          currentInput: effectiveInput,
        }, config);
        timeout.signal.throwIfAborted();
        const capabilityDisclosure = applyCapabilitySearchObservations(
          effectiveInput.capabilityDisclosure,
          result.capabilitySearchObservations ?? [],
        );
        if (result.plannerCommit) {
          const commit = parsePlannerCommit(
            result.plannerCommit,
            plannerCommitContext(input),
          );
          return {
            ...commit,
            capabilityDisclosure,
            messageUpdates: buildPlannerMessageUpdates({
              input,
              resultMessages: result.messages,
            }),
          };
        }
        if (explorer.didReachDocumentReadLimit()) {
          throw new CapabilityPlannerAgentError(
            'planning_limit_reached',
            'Capability Planner document read limit was reached before a valid commit.',
          );
        }
        return {
          plannerStatus: 'incomplete',
          reason: 'terminal_commit_missing',
          capabilityDisclosure,
          messageUpdates: buildPlannerMessageUpdates({
            input,
            resultMessages: result.messages,
          }),
        };
      } catch (error) {
        if (timeout.didTimeOut()) {
          throw new CapabilityPlannerAgentError(
            'planning_timeout',
            `Capability Planner exceeded its ${String(timeoutMs)}ms timeout.`,
          );
        }
        throw error;
      } finally {
        timeout.dispose();
        explorers.delete(input.inputId);
      }
    },
  });
}
