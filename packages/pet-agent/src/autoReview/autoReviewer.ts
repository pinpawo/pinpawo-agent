import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { invokeStructuredOutput } from '../utils/structuredOutput';
import { buildAutoReviewPrompt, buildAutoReviewSystemPrompt } from './prompts/input';
import type { AutoReviewInput, AutoReviewResult, AutoReviewer, AutoReviewStructuredOutputConfig } from './types';

const AUTO_REVIEW_RESULT_SCHEMA = z.object({
  riskScore: z.number().int().min(0).max(10).describe(
    'Risk from 0 to 10. Scores 0-2 pass strict review, 3-9 require relaxed review, and 10 always requires human review.',
  ),
  reason: z.string().optional().default('').describe(
    'A concise explanation grounded in the concrete action facts and authorization policy.',
  ),
});

/** Runs the production auto-review prompt and returns its raw risk assessment. */
export async function assessAutoReviewRisk(options: AutoReviewInput & {
  model: BaseChatModel;
  structuredOutput?: AutoReviewStructuredOutputConfig;
}): Promise<AutoReviewResult> {
  const prompt = buildAutoReviewPrompt({
    task: options.task,
    reviews: options.reviews,
  });
  if (!prompt.complete) return { complete: false };

  const assessment = await invokeStructuredOutput({
    model: options.model,
    schema: AUTO_REVIEW_RESULT_SCHEMA,
    options: {
      name: 'global_review_policy_auto_assessment',
      autoRepair: true,
      ...options.structuredOutput,
    },
    messages: [
      new SystemMessage(buildAutoReviewSystemPrompt(
        options.reviews,
        options.structuredOutput?.method,
      )),
      new HumanMessage(prompt.text),
    ],
    // The auto-review risk assessment is private, not delegated-agent progress.
    // Do not inherit the root stream callbacks that project model messages.
    runnableConfig: { callbacks: [] },
  });

  return { complete: true, assessment };
}

/** Bind execution dependencies once; no session state is kept by the evaluator. */
export function createAutoReviewer(options: {
  model: BaseChatModel;
  structuredOutput?: AutoReviewStructuredOutputConfig;
}): AutoReviewer {
  return Object.freeze({ assess: (input: AutoReviewInput) => assessAutoReviewRisk({ ...input, ...options }) });
}
