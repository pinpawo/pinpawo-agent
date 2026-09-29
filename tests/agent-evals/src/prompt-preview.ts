import type { RenderedDecisionPrompt } from './decision-eval-scenarios.ts';

export type PromptPreviewMetrics = {
  systemChars: number;
  inputChars: number;
  totalChars: number;
  systemLines: number;
  inputLines: number;
  approximateTokens: number;
};

export function estimatePromptTokens(text: string): number {
  const cjkChars = [...text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)].length;
  const otherChars = Math.max(0, text.length - cjkChars);
  return Math.ceil(cjkChars + otherChars / 4);
}

export function measureDecisionPrompt(prompt: RenderedDecisionPrompt): PromptPreviewMetrics {
  const conversation = prompt.conversationMessages?.map((message) => {
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content);
    return `[${message._getType()}]\n${content}`;
  }).join('\n') ?? '';
  const renderedInput = [prompt.input, conversation].filter(Boolean).join('\n');
  const combined = `${prompt.system}\n${renderedInput}`;
  return {
    systemChars: prompt.system.length,
    inputChars: renderedInput.length,
    totalChars: combined.length,
    systemLines: prompt.system.split('\n').length,
    inputLines: renderedInput.split('\n').length,
    approximateTokens: estimatePromptTokens(combined),
  };
}
