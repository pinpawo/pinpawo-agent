import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredTool } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import {
  createRunSupervisorFileExplorer,
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
import { systemPromptMiddleware } from '../../../prompts/systemPrompt';
import { createSupervisorMiddleware } from './supervisorMiddleware';
import { supervisorCommandContext } from './supervisorState';
import {
  mergeCapabilityDisclosure,
} from './capabilityDisclosure';
import {
  createSupervisorCapabilityDetailsTool,
  createSupervisorDisclosureStateMiddleware,
} from './detailsTool';
import { createSupervisorCommandTools } from './commandTools';
import { createCapabilityRoutingManifestResolver } from './routingManifest';

const DEFAULT_TIMEOUT_MS = 60_000;

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
  const capabilityDetailsTool = createSupervisorCapabilityDetailsTool({
    explorerForInput,
  });
  const middleware = createSupervisorMiddleware();
  const agent = createAgent({
    name: 'runSupervisor',
    model: params.model,
    tools: [capabilityDetailsTool, ...commandTools, ...additionalTools],
    middleware: [
      middleware,
      createSupervisorDisclosureStateMiddleware(),
      systemPromptMiddleware,
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
        const effectiveInput = input;
        const routingManifest = await resolveRoutingManifest({
          workspace: input.workspace,
          ...(params.defaultCapabilityName !== undefined
            ? { defaultCapabilityName: params.defaultCapabilityName }
            : {}),
          runnableConfig: config,
        });
        timeout.signal.throwIfAborted();
        const explorer = explorerForInput(effectiveInput);
        const disclosedCapabilities = await explorer.readCapabilities(
          effectiveInput.capabilityDisclosure.disclosedCapabilityNames, timeout.signal,
        );
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
        const capabilityDisclosure = mergeCapabilityDisclosure(
          effectiveInput.capabilityDisclosure,
          result.disclosedCapabilityNames ?? [],
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
        const reply = result.messages.at(-1);
        if (!reply || !AIMessage.isInstance(reply) || reply.tool_calls?.length || !reply.text.trim()) {
          throw new Error('Supervisor produced neither a control proposal nor a usable final reply.');
        }
        return { reply: reply.text, capabilityDisclosure };
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
