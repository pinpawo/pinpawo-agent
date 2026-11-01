import type { StructuredOutputMethod } from '@pinpawo/pet-agent';
import type { ModelInputModality, ModelProtocol } from './modelProfiles';

export type AgentLlmConfig = {
  protocol?: ModelProtocol;
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
  timeoutMs?: number;
  maxRetries?: number;
  verbose?: boolean;
  /**
   * Override structured-output retry behavior after parse/schema failure.
   * When unset, every structured-output method retries once.
   */
  structuredOutputAutoRepair?: boolean;
  /** Additional repair retries after the initial structured-output call. Default: 1 when enabled. */
  structuredOutputRepairMaxRetries?: number;
};
