import type {
  BuiltinGlobalReviewPolicyMode,
  StructuredOutputMethod,
} from '@pinpawo/pet-agent';
import type { ModelInputModality } from './modelProfiles';

export type AgentLlmConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  modelProfileId?: string;
  modelProfileFingerprint?: string;
  inputModalities?: readonly ModelInputModality[];
  structuredOutputMethod?: StructuredOutputMethod;
  maxOutputTokens?: number;
  observeModel?: string;
  contextWindowTokens?: number;
  subagentContextWindowTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
  verbose?: boolean;
  /** Enable thinking/reasoning for subagent calls. Default: false. */
  subagentThinking?: boolean;
  /** Retry the same structured-output LLM call after parse/schema failure. Default: false. */
  structuredOutputAutoRepair?: boolean;
  /** Additional repair retries after the initial structured-output call. Default: 1 when enabled. */
  structuredOutputRepairMaxRetries?: number;
  /** Global handling for tool calls that request review. Default: require_authorization. */
  globalReviewPolicyMode?: BuiltinGlobalReviewPolicyMode;
};
