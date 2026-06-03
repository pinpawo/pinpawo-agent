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
  /**
   * 配置的模型是否支持多模态(图片输入)。为 true 时,capability subagent 会把工具产出的
   * 图片(如浏览器截图)喂给模型;为 false / 省略时只保留工具的文本结果。默认 false。
   */
  multimodal?: boolean;
};
