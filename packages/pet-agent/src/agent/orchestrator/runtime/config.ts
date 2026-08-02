import type { RunnableConfig } from '@langchain/core/runnables';
import type { AgentActor, AgentExecution } from '../../../types/agent';
import type { ToolkitReviewCapabilities } from '../../../types/toolkit';
import type { CompiledAgentRegistry } from '../registry';
import {
  GLOBAL_REVIEW_POLICY_MODE,
  type GlobalReviewPolicy,
  type GlobalReviewPolicyBatchResolver,
  type GlobalReviewPolicyMode,
  type GlobalReviewPolicyResolver,
  type GlobalReviewPolicyStructuredOutputConfig,
} from '../review/globalReviewPolicy';
import type { OrchestratorConfig, OrchestratorInvokeOptions } from '../types';

export function getInvokeOptions(runnableConfig?: RunnableConfig): OrchestratorInvokeOptions {
  const cfg = runnableConfig?.configurable ?? {};
  const registry = cfg.registry as CompiledAgentRegistry | undefined;
  return {
    actor: cfg.actor as AgentActor | undefined,
    registry,
    execution: cfg.execution as AgentExecution | undefined,
    workdir: cfg.workdir as string | undefined,
    runtimeEnvironment: cfg.runtimeEnvironment as string | undefined,
    reviewCapabilities: readToolkitReviewCapabilities(cfg.reviewCapabilities),
    globalReviewPolicy: readGlobalReviewPolicy(cfg.globalReviewPolicy),
    maxRunIterations: readRunIterationLimit(cfg.maxRunIterations),
    allowedCapabilityNames: Array.isArray(
      (cfg as { allowedCapabilityNames?: unknown }).allowedCapabilityNames,
    )
      ? (cfg as { allowedCapabilityNames: unknown[] }).allowedCapabilityNames.filter(
          (name): name is string => typeof name === 'string' && name.length > 0,
      )
      : undefined,
  };
}

export function getInvokeRegistry(runnableConfig?: RunnableConfig): CompiledAgentRegistry {
  const registry = getInvokeOptions(runnableConfig).registry;
  if (!registry) {
    throw new Error(
      'Orchestrator requires a host-compiled registry. Use runAgent or pass configurable.registry.',
    );
  }
  return registry;
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
      ...(typeof record.resolveBatch === 'function'
        ? { resolveBatch: record.resolveBatch as GlobalReviewPolicyBatchResolver }
        : {}),
      ...(record.reuseAutoAuthorizations === true
        ? { reuseAutoAuthorizations: true }
        : {}),
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

export function readSubagentGenerationReserveTokens(config: OrchestratorConfig): number | undefined {
  return config.subagentGenerationReserveTokens ?? config.generationReserveTokens;
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
