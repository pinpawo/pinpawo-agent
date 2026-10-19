import {
  hasOnlyKeys,
  isJsonObject,
  readNonEmptyString,
} from './json';

export type TokenUsageSource = 'provider';
export type TokenUsageScope = 'run' | 'session';

/** Provider-reported usage as observed at an agent boundary. */
export type TokenUsageSnapshot = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Cache reads are a subset of input; absence means unavailable. */
  cachedInputTokens?: number;
  cacheEligibleInputTokens?: number;
  /** Known usage only: failed/unreported attempts and legacy history may be missing. */
  incomplete?: boolean;
  unknownCalls?: number;
  /** Monotonic revision of the persisted absolute session ledger. */
  usageRevision?: number;
  /** Distinguishes a rebuilt transient ledger from an earlier Host lifetime. */
  usageEpoch?: string;
  /** Final provider output / (model end - first stream output), excluding TTFT. */
  outputTokensPerSecond?: number;
  outputRateSource?: 'stream' | 'final';
  latestInputTokens?: number;
  contextWindow?: number;
  updatedAt?: string;
  source?: TokenUsageSource;
  scope?: TokenUsageScope;
};

export type AgentWorkStatus = 'running' | 'waiting_interaction';

/** Observable, resumable work. It does not expose a runtime state transition. */
export type AgentWorkSnapshot = {
  id: string;
  status: AgentWorkStatus;
  resumable: boolean;
  cancellable: boolean;
};

export type AgentWorkCommand =
  | { type: 'resume'; workId: string }
  | { type: 'cancel'; workId: string };

export type AgentStateSnapshot = {
  activeWork: AgentWorkSnapshot | null;
  tokenUsage?: TokenUsageSnapshot;
};

function readFiniteNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isTokenCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

export function parseTokenUsageSnapshot(value: unknown): TokenUsageSnapshot | null {
  if (!isJsonObject(value)) return null;
  const inputTokens = readFiniteNumber(value, 'inputTokens');
  const outputTokens = readFiniteNumber(value, 'outputTokens');
  const totalTokens = readFiniteNumber(value, 'totalTokens');
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens) || !isTokenCount(totalTokens)) return null;
  const optionalCounts: Record<string, number> = {};
  for (const key of ['cachedInputTokens', 'cacheEligibleInputTokens', 'unknownCalls', 'usageRevision']) {
    if (value[key] === undefined) continue;
    const count = readFiniteNumber(value, key);
    if (count === undefined || !Number.isSafeInteger(count) || count < 0) return null;
    optionalCounts[key] = count;
  }
  const cached = optionalCounts.cachedInputTokens;
  const eligible = optionalCounts.cacheEligibleInputTokens;
  if ((eligible !== undefined && eligible > inputTokens)
    || (cached !== undefined && (cached > inputTokens || (eligible !== undefined && cached > eligible)))) return null;
  const speed = readFiniteNumber(value, 'outputTokensPerSecond');
  if (value.outputTokensPerSecond !== undefined && (speed === undefined || speed < 0)) return null;
  if (value.usageEpoch !== undefined && (typeof value.usageEpoch !== 'string' || !value.usageEpoch.trim())) return null;
  const latestInputTokens = readFiniteNumber(value, 'latestInputTokens');
  const contextWindow = readFiniteNumber(value, 'contextWindow');
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : undefined;
  const source = value.source === 'provider' ? value.source : undefined;
  const scope = value.scope === 'run' || value.scope === 'session' ? value.scope : undefined;
  return {
    inputTokens: inputTokens,
    outputTokens: outputTokens,
    totalTokens: totalTokens,
    ...optionalCounts,
    ...(speed !== undefined ? { outputTokensPerSecond: speed } : {}),
    ...(typeof value.usageEpoch === 'string' ? { usageEpoch: value.usageEpoch } : {}),
    ...(value.outputRateSource === 'stream' || value.outputRateSource === 'final' ? { outputRateSource: value.outputRateSource } : {}),
    ...(value.incomplete === true ? { incomplete: true } : {}),
    ...(latestInputTokens !== undefined ? { latestInputTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
}

export function isTokenUsageSnapshot(value: unknown): value is TokenUsageSnapshot {
  return parseTokenUsageSnapshot(value) !== null;
}

export function parseAgentWorkSnapshot(value: unknown): AgentWorkSnapshot | null {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['id', 'status', 'resumable', 'cancellable'])) {
    return null;
  }
  const id = readNonEmptyString(value.id);
  if (
    id === null
    || (value.status !== 'running' && value.status !== 'waiting_interaction')
    || typeof value.resumable !== 'boolean'
    || typeof value.cancellable !== 'boolean'
  ) {
    return null;
  }
  return {
    id,
    status: value.status,
    resumable: value.resumable,
    cancellable: value.cancellable,
  };
}

export function parseAgentWorkCommand(value: unknown): AgentWorkCommand | null {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['type', 'workId'])) return null;
  const workId = readNonEmptyString(value.workId);
  if (
    (value.type !== 'resume' && value.type !== 'cancel')
    || workId === null
  ) {
    return null;
  }
  return { type: value.type, workId };
}

export function parseAgentStateSnapshot(value: unknown): AgentStateSnapshot | null {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['activeWork', 'tokenUsage'])) return null;
  const activeWork = value.activeWork === null ? null : parseAgentWorkSnapshot(value.activeWork);
  const tokenUsage = value.tokenUsage === undefined
    ? undefined
    : parseTokenUsageSnapshot(value.tokenUsage);
  if (activeWork === null && value.activeWork !== null) return null;
  if (value.tokenUsage !== undefined && !tokenUsage) return null;
  return {
    activeWork,
    ...(tokenUsage ? { tokenUsage } : {}),
  };
}
