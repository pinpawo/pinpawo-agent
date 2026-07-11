import { buildOrchestratorDecisionPromptPrefix } from '../src/agent/orchestrator/prompts/shared.ts';
import type { RenderedDecisionPrompt } from './decision-eval-scenarios.ts';

export type PromptPreviewMetrics = {
  systemChars: number;
  inputChars: number;
  totalChars: number;
  systemLines: number;
  inputLines: number;
  approximateTokens: number;
  sharedPrefixPercent: number;
};

export function estimatePromptTokens(text: string): number {
  const cjkChars = [...text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)].length;
  const otherChars = Math.max(0, text.length - cjkChars);
  return Math.ceil(cjkChars + otherChars / 4);
}

export function measureDecisionPrompt(prompt: RenderedDecisionPrompt): PromptPreviewMetrics {
  const combined = `${prompt.system}\n${prompt.input}`;
  const sharedPrefix = buildOrchestratorDecisionPromptPrefix();
  return {
    systemChars: prompt.system.length,
    inputChars: prompt.input.length,
    totalChars: combined.length,
    systemLines: prompt.system.split('\n').length,
    inputLines: prompt.input.split('\n').length,
    approximateTokens: estimatePromptTokens(combined),
    sharedPrefixPercent: prompt.system.includes(sharedPrefix)
      ? Math.round((sharedPrefix.length / prompt.system.length) * 100)
      : 0,
  };
}
