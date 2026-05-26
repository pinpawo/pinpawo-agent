export type AgentLlmConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  observeModel?: string;
  contextWindowTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
  verbose?: boolean;
  /** Enable thinking/reasoning for subagent calls. Default: false. */
  subagentThinking?: boolean;
};
