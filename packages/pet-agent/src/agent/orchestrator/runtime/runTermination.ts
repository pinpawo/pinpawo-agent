import { randomUUID } from 'node:crypto';
import { Command, type NodeError } from '@langchain/langgraph';
import { snapshotPlannerTaskContinuation } from '../capabilityPlanner/session';
import type { CapabilityPlannerDispatch } from '../capabilityPlanner/runner';
import type {
  OrchestratorStateType,
  OrchestratorTerminalErrorState,
} from '../state';

type FailureNodeInput = OrchestratorStateType | CapabilityPlannerDispatch;

function rootState(input: FailureNodeInput): OrchestratorStateType {
  return 'plannerState' in input
    ? input.plannerState as OrchestratorStateType
    : input;
}

function readStringProperty(error: Error, property: string): string | null {
  const value = (error as unknown as Record<string, unknown>)[property];
  return typeof value === 'string' && value ? value : null;
}

function readLangChainErrorCode(error: Error): string | null {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 10; depth += 1) {
    const record = current as { lc_error_code?: unknown; cause?: unknown };
    if (typeof record.lc_error_code === 'string' && record.lc_error_code) {
      return record.lc_error_code;
    }
    current = record.cause;
  }
  return null;
}

function serializeTerminalError(nodeError: NodeError): OrchestratorTerminalErrorState {
  return {
    id: randomUUID(),
    node: nodeError.node,
    name: nodeError.error.name || 'Error',
    message: nodeError.error.message,
    code: readStringProperty(nodeError.error, 'code'),
    langChainErrorCode: readLangChainErrorCode(nodeError.error),
  };
}

function restoreTerminalError(error: OrchestratorTerminalErrorState): Error {
  const restored = new Error(error.message);
  restored.name = error.name;
  if (error.code) {
    Object.assign(restored, { code: error.code });
  }
  if (error.langChainErrorCode) {
    Object.assign(restored, { lc_error_code: error.langChainErrorCode });
  }
  return restored;
}

function cloneError(error: Error): Error {
  return Object.create(
    Object.getPrototypeOf(error),
    Object.getOwnPropertyDescriptors(error),
  ) as Error;
}

/**
 * Route terminal node failures through one checkpointed cleanup superstep.
 * The following node rethrows the original Error; serialized fields are only
 * a restart-safe fallback if the process is replaced between those steps.
 */
export function createRunTerminationHandlers() {
  const pendingErrors = new Map<string, Error>();

  return {
    onNodeError(input: FailureNodeInput, nodeError: NodeError) {
      const state = rootState(input);
      const terminalError = serializeTerminalError(nodeError);
      pendingErrors.set(terminalError.id, nodeError.error);
      return new Command({
        update: {
          runNextDelegation: null,
          runPlannerSession: null,
          taskPlannerContinuation: state.taskPlannerContinuation
            ?? snapshotPlannerTaskContinuation({
              activeDelegation: state.taskActiveDelegation ?? null,
              plannerSession: state.runPlannerSession ?? null,
            }),
          runIterationCount: 0,
          runTerminalOutcome: null,
          runTerminalError: terminalError,
        },
        goto: 'throwRunFailure',
      });
    },

    throwRunFailure(state: OrchestratorStateType): never {
      const terminalError = state.runTerminalError;
      if (!terminalError) {
        throw new Error('Orchestrator failure node has no terminal error state.');
      }
      const originalError = pendingErrors.get(terminalError.id);
      pendingErrors.delete(terminalError.id);
      // LangGraph remembers the exact Error object handled by the recovery
      // node. Throw an equivalent object so the terminal failure is not
      // mistaken for the already-compensated exception.
      throw originalError ? cloneError(originalError) : restoreTerminalError(terminalError);
    },
  };
}
