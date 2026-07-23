import type { RunnableConfig } from '@langchain/core/runnables';
import type { AgentActor, AgentExecution } from '../../../types/agent';
import type { AgentCapability } from '../../../types/capability';
import type { AgentToolkit, ToolkitReviewCapabilities } from '../../../types/toolkit';
import {
  GLOBAL_REVIEW_POLICY_MODE,
  type GlobalReviewPolicy,
  type GlobalReviewPolicyMode,
  type GlobalReviewPolicyResolver,
  type GlobalReviewPolicyStructuredOutputConfig,
} from '../review/globalReviewPolicy';
import type { OrchestratorConfig, OrchestratorInvokeOptions } from '../types';

export function generalLaneToolkits(toolkits: AgentToolkit[]) {
  return toolkits;
}

export function capabilityLaneToolkits(toolkits: AgentToolkit[]) {
  return toolkits;
}

export function getInvokeOptions(runnableConfig?: RunnableConfig): OrchestratorInvokeOptions {
  const cfg = runnableConfig?.configurable ?? {};
  return {
    actor: cfg.actor as AgentActor | undefined,
    capabilities: (cfg.capabilities ?? []) as AgentCapability[],
    toolkits: (cfg.toolkits ?? []) as AgentToolkit[],
    execution: cfg.execution as AgentExecution | undefined,
    workdir: cfg.workdir as string | undefined,
    artifactDiscoveryRoot: typeof cfg.artifactDiscoveryRoot === 'string'
      ? cfg.artifactDiscoveryRoot
      : undefined,
    artifactDiscoveryToolkit: cfg.artifactDiscoveryToolkit as AgentToolkit | undefined,
    runtimeEnvironment: cfg.runtimeEnvironment as string | undefined,
    reviewCapabilities: readToolkitReviewCapabilities(cfg.reviewCapabilities),
    globalReviewPolicy: readGlobalReviewPolicy(cfg.globalReviewPolicy),
    maxRunIterations: readRunIterationLimit(cfg.maxRunIterations),
    forcedCapabilityNames: Array.isArray((cfg as { forcedCapabilityNames?: unknown }).forcedCapabilityNames)
      ? (cfg as { forcedCapabilityNames: unknown[] }).forcedCapabilityNames.filter(
          (name): name is string => typeof name === 'string' && name.length > 0,
      )
      : undefined,
  };
}

function readGlobalReviewPolicyMode(value: unknown): GlobalReviewPolicyMode | null {
  if (
    value === GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION
    || value === GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION
    || value === GLOBAL_REVIEW_POLICY_MODE.FULL_ACCESS
    || value === GLOBAL_REVIEW_POLICY_MODE.CUSTOM
  ) {
    return value;
  }
  if (value === 'ask') {
    return GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION;
  }
  if (value === 'auto') {
    return GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION;
  }
  return null;
}

function warnBareCustomGlobalReviewPolicy() {
  console.warn(
    '[pet-agent] custom global review policy requires a resolver; falling back to require_authorization.',
  );
}

function readGlobalReviewPolicy(value: unknown): GlobalReviewPolicy | undefined {
  const directMode = readGlobalReviewPolicyMode(value);
  if (directMode) {
    if (directMode === GLOBAL_REVIEW_POLICY_MODE.CUSTOM) {
      warnBareCustomGlobalReviewPolicy();
      return undefined;
    }
    return { mode: directMode };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const mode = readGlobalReviewPolicyMode(record.mode);
  if (!mode) {
    return undefined;
  }
  if (mode === GLOBAL_REVIEW_POLICY_MODE.CUSTOM) {
    if (typeof record.resolve !== 'function') {
      warnBareCustomGlobalReviewPolicy();
      return undefined;
    }
    return {
      mode,
      resolve: record.resolve as GlobalReviewPolicyResolver,
    };
  }
  const structuredOutput = record.structuredOutput
    && typeof record.structuredOutput === 'object'
    && !Array.isArray(record.structuredOutput)
    ? record.structuredOutput as GlobalReviewPolicyStructuredOutputConfig
    : undefined;
  return {
    mode,
    ...(structuredOutput ? { structuredOutput } : {}),
  };
}

export function readThreadId(runnableConfig?: RunnableConfig): string | null {
  const value = runnableConfig?.configurable?.thread_id;
  return typeof value === 'string' && value.trim() ? value : null;
}

function readToolkitReviewCapabilities(value: unknown): ToolkitReviewCapabilities | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.humanReview !== 'boolean' || typeof record.sessionAuthorization !== 'boolean') {
    return undefined;
  }
  return {
    humanReview: record.humanReview,
    sessionAuthorization: record.sessionAuthorization,
  };
}

export function readRunIterationLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

export function readSubagentContextWindowTokens(config: OrchestratorConfig): number | undefined {
  return config.subagentContextWindowTokens ?? config.contextWindowTokens;
}

export function resolveActor(config: OrchestratorConfig, runnableConfig?: RunnableConfig): AgentActor {
  const invokeActor = getInvokeOptions(runnableConfig).actor;
  if (invokeActor) {
    return invokeActor;
  }
  if (config.actor) {
    return config.actor;
  }
  throw new Error('Missing actor in orchestrator config and invoke options');
}
