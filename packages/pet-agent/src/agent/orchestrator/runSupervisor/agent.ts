import { HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredTool } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import {
  createRunSupervisorFileExplorer,
  type RunSupervisorCapabilityDocument,
  type RunSupervisorFileExplorer,
} from './fileExplorer';
import type { CapabilityRegistryBackend } from './registryDocuments';
import { buildRunSupervisorAgentInput } from '../prompts/runSupervisorAgent';
import type {
  RunSupervisorInput,
  RunSupervisorResult,
  RunSupervisorRunner,
} from './runner';
import { parseSupervisorCommand } from './protocol';
import { queryAgentMessages } from '../../messages';
import { orchestratorModelInvocationMiddleware } from '../modelInvocation';
import { createSupervisorMiddleware } from './supervisorMiddleware';
import { supervisorCommandContext } from './supervisorState';
import {
  applyCapabilitySearchObservations,
  removeSearchedCapabilities,
} from './capabilityDisclosure';
import {
  createSupervisorCapabilitySearchTool,
  createSupervisorSearchStateMiddleware,
} from './searchTool';
import { createSupervisorCommandTools } from './commandTools';
import { SupervisorFileToolError } from './workspaceReader';
import { createCapabilityRoutingManifestResolver } from './routingManifest';
import type { PetDocument } from '../../../types/petDocument';

const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_RUN_SUPERVISOR_MAX_SEARCH_ROUNDS = 2;

export type RunSupervisorAgentErrorCode =
  | 'supervisor_discovery_limit_reached'
  | 'supervisor_timeout';

export class RunSupervisorAgentError extends Error {
  readonly code: RunSupervisorAgentErrorCode;

  constructor(code: RunSupervisorAgentErrorCode, message: string) {
    super(message);
    this.name = 'RunSupervisorAgentError';
    this.code = code;
  }
}

function mergeSupervisorSignal(
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

function readCachedSupervisorCommand(input: RunSupervisorInput) {
  const cached = input.supervisorSession.lastCommand;
  return cached
    && cached.inputId === input.inputId
    && cached.registryDigest === input.workspace.registryDigest
    ? cached.command
    : null;
}

function buildSupervisorRunnableConfig(params: {
  input: RunSupervisorInput;
  runnableConfig?: RunnableConfig;
  signal: AbortSignal;
}): RunnableConfig {
  return {
    ...params.runnableConfig,
    signal: params.signal,
    runName: 'framework.run_supervisor',
    tags: [
      ...(params.runnableConfig?.tags ?? []),
      'framework.run_supervisor',
    ],
    metadata: {
      ...(params.runnableConfig?.metadata ?? {}),
      frameworkComponent: 'run_supervisor',
      traceId: params.input.traceId,
      runId: params.input.runId,
      supervisorInputId: params.input.inputId,
      registryDigest: params.input.workspace.registryDigest,
      supervisorMode: params.input.mode,
    },
  };
}

export function createRunSupervisorAgent(params: {
  model: BaseChatModel;
  /** Capability identified as the Supervisor's default candidate. */
  defaultCapabilityName?: string;
  timeoutMs?: number;
  registryBackend?: CapabilityRegistryBackend;
  maxDocumentReadBytes?: number;
  /** Additional invocation-scoped Supervisor tools. */
  additionalTools?: StructuredTool[];
  petDocument?: PetDocument;
}): RunSupervisorRunner {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertPositiveInteger(timeoutMs, 'Run Supervisor timeoutMs');
  if (params.maxDocumentReadBytes !== undefined) {
    assertPositiveInteger(
      params.maxDocumentReadBytes,
      'Run Supervisor maxDocumentReadBytes',
    );
  }
  const explorers = new Map<string, RunSupervisorFileExplorer>();
  const resolveRoutingManifest = createCapabilityRoutingManifestResolver({
    model: params.model,
  });
  const explorerForInput = (input: RunSupervisorInput) => {
    const existing = explorers.get(input.inputId);
    if (existing) return existing;
    const explorer = createRunSupervisorFileExplorer({
      workspace: input.workspace,
      registryBackend: params.registryBackend ?? 'filesystem',
      ...(params.maxDocumentReadBytes
        ? { maxDocumentReadBytes: params.maxDocumentReadBytes }
        : {}),
    });
    explorers.set(input.inputId, explorer);
    return explorer;
  };
  const commandTools = createSupervisorCommandTools();
  const additionalTools = params.additionalTools ?? [];
  const capabilitySearchTool = createSupervisorCapabilitySearchTool({
    explorerForInput,
  });
  const middleware = createSupervisorMiddleware(params.petDocument);
  const agent = createAgent({
    name: 'runSupervisor',
    model: params.model,
    tools: [capabilitySearchTool, ...commandTools, ...additionalTools],
    middleware: [
      middleware,
      createSupervisorSearchStateMiddleware(),
      orchestratorModelInvocationMiddleware,
    ],
    checkpointer: false,
  });

  return Object.freeze({
    async invoke(
      input: RunSupervisorInput,
      runnableConfig?: RunnableConfig,
    ): Promise<RunSupervisorResult> {
      const timeout = mergeSupervisorSignal(runnableConfig?.signal, timeoutMs);
      const config = buildSupervisorRunnableConfig({
        input,
        runnableConfig,
        signal: timeout.signal,
      });
      try {
        timeout.signal.throwIfAborted();
        const cachedCommand = readCachedSupervisorCommand(input);
        if (cachedCommand) {
          return {
            ...parseSupervisorCommand(cachedCommand, supervisorCommandContext(input)),
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
        let disclosedCapabilities: RunSupervisorCapabilityDocument[];
        try {
          disclosedCapabilities = await explorer.readCapabilities(
            effectiveInput.capabilityDisclosure.disclosedCapabilityNames,
            timeout.signal,
          );
        } catch (error) {
          if (!(error instanceof SupervisorFileToolError)
            || error.code !== 'supervisor_discovery_limit_reached') {
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
        const supervisorInputMessage = new HumanMessage({
          id: `supervisor:${input.inputId}`,
          content: buildRunSupervisorAgentInput(
            effectiveInput,
            disclosedCapabilities,
            routingManifest,
          ),
        });
        const agentMessages = queryAgentMessages(input.messages)
          .main()
          .append(supervisorInputMessage)
          .select()
          .messages;
        const result = await agent.invoke({
          messages: agentMessages,
          currentInput: effectiveInput,
        }, config);
        timeout.signal.throwIfAborted();
        const capabilityDisclosure = applyCapabilitySearchObservations(
          effectiveInput.capabilityDisclosure,
          result.capabilitySearchObservations ?? [],
        );
        if (result.supervisorCommand) {
          const command = parseSupervisorCommand(
            result.supervisorCommand,
            supervisorCommandContext(input),
          );
          return {
            ...command,
            capabilityDisclosure,
          };
        }
        if (explorer.didReachDocumentReadLimit()) {
          throw new RunSupervisorAgentError(
            'supervisor_discovery_limit_reached',
            'Run Supervisor document read limit was reached before a valid command.',
          );
        }
        return {
          supervisorStatus: 'no_command',
          reason: 'command_missing',
          capabilityDisclosure,
        };
      } catch (error) {
        if (timeout.didTimeOut()) {
          throw new RunSupervisorAgentError(
            'supervisor_timeout',
            `Run Supervisor exceeded its ${String(timeoutMs)}ms timeout.`,
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
