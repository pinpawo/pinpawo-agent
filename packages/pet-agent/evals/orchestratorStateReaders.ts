import type { OrchestratorStateType } from '../src/agent/orchestrator/state';
import type {
  CapabilityMessageLane,
  RunDelegationSummary,
  RunNextDelegation,
  TaskActiveDelegation,
} from '../src/agent/orchestrator/types';

export type EvalOrchestratorStateSnapshot = Partial<Pick<
  OrchestratorStateType,
  | 'runNextDelegation'
  | 'runDelegationSummaries'
  | 'taskActiveDelegation'
>> & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function isCapabilityLane(value: unknown): value is CapabilityMessageLane {
  return typeof value === 'string' && value.startsWith('capability:');
}

function isDelegationStatus(value: unknown): value is RunDelegationSummary['status'] {
  return value === 'pending' || value === 'progress' || value === 'completed';
}

function isRunDelegationSummary(value: unknown): value is RunDelegationSummary {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && isCapabilityLane(value.lane)
    && (value.mode === 'initial' || value.mode === 'continue')
    && typeof value.task === 'string'
    && isDelegationStatus(value.status)
    && (value.resultPreview === null || typeof value.resultPreview === 'string');
}

function isRunNextDelegation(value: unknown): value is RunNextDelegation {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && isCapabilityLane(value.lane)
    && typeof value.task === 'string'
    && (value.contextSummary === null || typeof value.contextSummary === 'string');
}

function isTaskActiveDelegation(value: unknown): value is TaskActiveDelegation {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && isCapabilityLane(value.lane)
    && typeof value.task === 'string'
    && (value.contextSummary === null || typeof value.contextSummary === 'string')
    && typeof value.runId === 'string'
    && (value.status === 'pending' || value.status === 'awaiting_decision')
    && (value.resultPreview === null || typeof value.resultPreview === 'string');
}

export function readPendingDelegation(result: EvalOrchestratorStateSnapshot): RunNextDelegation | null {
  return isRunNextDelegation(result.runNextDelegation) ? result.runNextDelegation : null;
}

export function routeModeFromResult(result: EvalOrchestratorStateSnapshot): 'answer' | 'capability' {
  const lane = readPendingDelegation(result)?.lane;
  if (typeof lane === 'string' && lane.startsWith('capability:')) return 'capability';
  return 'answer';
}

export function activeCapabilityFromResult(result: EvalOrchestratorStateSnapshot): string | null {
  const lane = readPendingDelegation(result)?.lane;
  return typeof lane === 'string' && lane.startsWith('capability:')
    ? lane.slice('capability:'.length)
    : null;
}

export function readRunDelegationSummaries(result: EvalOrchestratorStateSnapshot): RunDelegationSummary[] {
  return Array.isArray(result.runDelegationSummaries)
    ? result.runDelegationSummaries.filter(isRunDelegationSummary)
    : [];
}

export function readTaskActiveDelegation(result: EvalOrchestratorStateSnapshot): TaskActiveDelegation | null {
  return isTaskActiveDelegation(result.taskActiveDelegation) ? result.taskActiveDelegation : null;
}

export function hasObservedDelegation(result: EvalOrchestratorStateSnapshot): boolean {
  const activeDelegation = readTaskActiveDelegation(result);
  return activeDelegation?.status === 'awaiting_decision'
    || readRunDelegationSummaries(result).some((delegation) =>
      delegation.status === 'progress' || delegation.status === 'completed'
    );
}
