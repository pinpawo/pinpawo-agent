import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredTool } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import {
  buildSystemPolicy,
  SYSTEM_POLICY_SOURCE,
  SYSTEM_POLICY_TARGET,
} from '../../modelContext/systemPolicy';
import { createInvocationContextMessage } from '../../modelContext/invocationContext';
import {
  CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
  createCapabilityPlannerFileExplorer,
  type CapabilityPlannerCapabilityDocument,
  type CapabilityPlannerFileExplorer,
} from './fileExplorer';
import type { CapabilityRegistryBackend } from './registryDocuments';
import {
  buildCapabilityPlannerAgentInput,
  buildCapabilityPlannerAgentSystemPrompt,
} from '../prompts/capabilityPlannerAgent';
import type {
  CapabilityPlannerInput,
  CapabilityPlannerResult,
  CapabilityPlannerRunner,
} from './runner';
import { parsePlannerCommit } from './protocol';
import { queryAgentMessages } from '../../messages';
import { orchestratorModelInvocationMiddleware } from '../modelInvocation';
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
import {
  createPlannerTerminalTools,
  PLANNER_TERMINAL_TOOL_NAMES,
  type PlannerTerminalToolMode,
} from './terminalTools';
import { PlannerFileToolError } from './workspaceReader';
import { createCapabilityRoutingManifestResolver } from './routingManifest';

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

function readCachedPlannerCommit(input: CapabilityPlannerInput) {
  const cached = input.plannerSession.lastCommit;
  return cached
    && cached.inputId === input.inputId
    && cached.registryDigest === input.workspace.registryDigest
    ? cached.decision
    : null;
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
  /** Capability identified as the Planner's default candidate. */
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
  const resolveRoutingManifest = createCapabilityRoutingManifestResolver({
    model: params.model,
  });
  const explorerForInput = (input: CapabilityPlannerInput) => {
    const existing = explorers.get(input.inputId);
    if (existing) return existing;
    const explorer = createCapabilityPlannerFileExplorer({
      workspace: input.workspace,
      registryBackend: params.registryBackend ?? 'filesystem',
      ...(params.maxDocumentReadBytes
        ? { maxDocumentReadBytes: params.maxDocumentReadBytes }
        : {}),
    });
    explorers.set(input.inputId, explorer);
    return explorer;
  };
  const additionalTools = params.additionalTools ?? [];
  for (const additionalTool of additionalTools) {
    if (additionalTool.name === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME
      || PLANNER_TERMINAL_TOOL_NAMES.has(additionalTool.name)) {
      throw new Error(
        `Capability Planner additionalTools cannot use reserved tool name "${additionalTool.name}".`,
      );
    }
  }
  const capabilitySearchTool = createPlannerCapabilitySearchTool({
    explorerForInput,
  });
  const createModeAgent = (mode: PlannerTerminalToolMode) => {
    const systemPolicy = buildSystemPolicy({
      target: SYSTEM_POLICY_TARGET.CAPABILITY_PLANNER,
      variant: mode,
      instructions: [{
        id: `framework:capability-planner:${mode}`,
        source: SYSTEM_POLICY_SOURCE.FRAMEWORK,
        content: buildCapabilityPlannerAgentSystemPrompt(mode),
      }],
    });
    return createAgent({
      name: `capabilityPlanner:${mode}`,
      model: params.model,
      systemPrompt: systemPolicy.message,
      tools: [
        capabilitySearchTool,
        ...createPlannerTerminalTools(mode),
        ...additionalTools,
      ],
      middleware: [
        createPlannerMiddleware(),
        createPlannerSearchStateMiddleware(),
        orchestratorModelInvocationMiddleware,
      ],
      checkpointer: false,
    });
  };
  const agents = {
    entry: createModeAgent('entry'),
    boundary: createModeAgent('boundary'),
  } as const;

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
        const routingManifest = await resolveRoutingManifest({
          workspace: input.workspace,
          ...(params.defaultCapabilityName !== undefined
            ? { defaultCapabilityName: params.defaultCapabilityName }
            : {}),
          runnableConfig: config,
        });
        timeout.signal.throwIfAborted();
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
            }),
          };
          // The failed explorer has already marked its budget as exhausted.
          // Recreate it so later searches use a clean invocation budget after
          // oversized disclosures are discarded.
          explorers.delete(input.inputId);
          explorer = explorerForInput(effectiveInput);
          disclosedCapabilities = await explorer.readCapabilities(
            effectiveInput.capabilityDisclosure.disclosedCapabilityNames,
            timeout.signal,
          );
        }
        const plannerInputMessage = createInvocationContextMessage({
          id: `planner:${input.inputId}`,
          name: 'capability_planner_input',
          content: buildCapabilityPlannerAgentInput(
            effectiveInput,
            disclosedCapabilities,
            routingManifest,
          ),
        });
        const agentMessages = queryAgentMessages(input.messages)
          .main()
          .append(plannerInputMessage)
          .select()
          .messages;
        const result = await agents[effectiveInput.mode].invoke({
          messages: agentMessages,
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
