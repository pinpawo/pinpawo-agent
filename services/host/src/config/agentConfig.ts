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
   * Override bounded structured-output repair after parse/schema failure.
   * When unset, every structured-output method allows one repair call with
   * validation feedback. Transport retries remain controlled by maxRetries.
   */
  structuredOutputAutoRepair?: boolean;
  /** Additional schema repair calls, capped at 3. Default: 1 when enabled. */
  structuredOutputRepairMaxRetries?: number;
};
