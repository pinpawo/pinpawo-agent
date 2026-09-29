import type { RunnableConfig } from '@langchain/core/runnables';
import { isToolAuthorizationSafetyLevel } from '@pinpawo/agent-contracts';
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

/**
 * Invoke options arrive through the untyped `configurable` bag. An absent
 * option keeps its default; a present but malformed one is a Host error and
 * fails the run instead of being dropped or coerced.
 */
export function getInvokeOptions(runnableConfig?: RunnableConfig): OrchestratorInvokeOptions {
  const cfg = runnableConfig?.configurable ?? {};
  return {
    registry: cfg.registry as CompiledAgentRegistry | undefined,
    reviewCapabilities: cfg.reviewCapabilities === undefined
      ? undefined : readToolkitReviewCapabilities(cfg.reviewCapabilities),
    globalReviewPolicy: cfg.globalReviewPolicy === undefined
      ? undefined : readGlobalReviewPolicy(cfg.globalReviewPolicy),
    allowedCapabilityNames: cfg.allowedCapabilityNames === undefined
      ? undefined : readAllowedCapabilityNames(cfg.allowedCapabilityNames),
  };
}

function invalidInvokeOption(name: string, expected: string): never {
  throw new Error(`Invalid configurable.${name}: expected ${expected}.`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readAllowedCapabilityNames(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((name) => typeof name === 'string' && name.length > 0)) {
    invalidInvokeOption('allowedCapabilityNames', 'an array of non-empty Capability names');
  }
  return value;
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

const GLOBAL_REVIEW_POLICY_MODES: readonly GlobalReviewPolicyMode[] = Object.values(GLOBAL_REVIEW_POLICY_MODE);

function readGlobalReviewPolicy(value: unknown): GlobalReviewPolicy {
  const expected = 'a GlobalReviewPolicy object';
  if (!isPlainRecord(value)) invalidInvokeOption('globalReviewPolicy', expected);
  const mode = value.mode;
  if (!GLOBAL_REVIEW_POLICY_MODES.includes(mode as GlobalReviewPolicyMode)) {
    invalidInvokeOption('globalReviewPolicy.mode', `one of ${GLOBAL_REVIEW_POLICY_MODES.join(', ')}`);
  }
  if (mode === GLOBAL_REVIEW_POLICY_MODE.CUSTOM) {
    if (typeof value.resolve !== 'function') invalidInvokeOption('globalReviewPolicy.resolve', 'a function for custom mode');
    if (value.resolveBatch !== undefined && typeof value.resolveBatch !== 'function') {
      invalidInvokeOption('globalReviewPolicy.resolveBatch', 'a function');
    }
    if (value.reuseAutoAuthorizations !== undefined && typeof value.reuseAutoAuthorizations !== 'boolean') {
      invalidInvokeOption('globalReviewPolicy.reuseAutoAuthorizations', 'a boolean');
    }
    return {
      mode,
      resolve: value.resolve as GlobalReviewPolicyResolver,
      ...(value.resolveBatch ? { resolveBatch: value.resolveBatch as GlobalReviewPolicyBatchResolver } : {}),
      ...(value.reuseAutoAuthorizations ? { reuseAutoAuthorizations: true } : {}),
    };
  }
  if (value.safetyLevel !== undefined && !isToolAuthorizationSafetyLevel(value.safetyLevel)) {
    invalidInvokeOption('globalReviewPolicy.safetyLevel', 'a ToolAuthorizationSafetyLevel');
  }
  if (value.structuredOutput !== undefined && !isPlainRecord(value.structuredOutput)) {
    invalidInvokeOption('globalReviewPolicy.structuredOutput', 'an object');
  }
  return {
    mode: mode as Exclude<GlobalReviewPolicyMode, typeof GLOBAL_REVIEW_POLICY_MODE.CUSTOM>,
    ...(value.safetyLevel ? { safetyLevel: value.safetyLevel } : {}),
    ...(value.structuredOutput ? { structuredOutput: value.structuredOutput as GlobalReviewPolicyStructuredOutputConfig } : {}),
  } as GlobalReviewPolicy;
}

export function readThreadId(runnableConfig?: RunnableConfig): string | null {
  const value = runnableConfig?.configurable?.thread_id;
  return typeof value === 'string' && value.trim() ? value : null;
}

function readToolkitReviewCapabilities(value: unknown): ToolkitReviewCapabilities {
  if (!isPlainRecord(value)
    || typeof value.humanReview !== 'boolean' || typeof value.sessionAuthorization !== 'boolean') {
    invalidInvokeOption('reviewCapabilities', '{ humanReview: boolean, sessionAuthorization: boolean }');
  }
  return {
    humanReview: value.humanReview,
    sessionAuthorization: value.sessionAuthorization,
  };
}

export function readSubagentContextWindowTokens(config: OrchestratorConfig): number | undefined {
  return config.subagentContextWindowTokens ?? config.contextWindowTokens;
}

export function readSubagentGenerationReserveTokens(config: OrchestratorConfig): number | undefined {
  return config.subagentGenerationReserveTokens ?? config.generationReserveTokens;
}
