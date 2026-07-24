import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { z } from 'zod';
import {
  buildOrchestrationDecisionStructuredOutputOptions,
} from '../src/agent/orchestrator/schemas.ts';
import type { AgentModels } from '../src/types/agent.ts';
import type { StructuredOutputMethod } from '../src/utils/structuredOutput.ts';
import type { DecisionContractScore } from './decision-contract-scorers.ts';

export type PromptGoalAcceptanceCriterion = {
  id: string;
  statement: string;
};

export type PromptEvalJudge = {
  model: AgentModels['act'];
  method?: StructuredOutputMethod;
  config?: RunnableConfig;
};

export class PromptEvalJudgeError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'PromptEvalJudgeError';
    this.cause = cause;
  }
}

function buildPromptGoalEvaluationSchema(criterionIds: string[]) {
  if (criterionIds.length === 0) throw new Error('Prompt evaluation requires acceptance criteria.');
  const criteriaShape = Object.fromEntries(criterionIds.map((id) => [id, z.object({
    met: z.boolean(),
    reason: z.string(),
  }).strict()]));
  return z.object({
    criteria: z.object(criteriaShape).strict(),
    summary: z.string(),
  }).strict();
}

export function buildPromptGoalEvaluatorPrompt(
  method?: StructuredOutputMethod,
  criterionIds: string[] = ['criterion_id'],
): string {
  const instructions = [
    'Evaluate whether a candidate output achieves the supplied objective.',
    'Judge every acceptance criterion independently using only the supplied evidence and candidate output.',
    'Accuracy and grounding require support from the supplied evidence. Treat unsupported additions as a failure when they affect a criterion.',
    'Return exactly one result for every criterion id. Keep each reason concise and evidence-based.',
  ];
  if (method === 'jsonMode') {
    instructions.push(
      'Return one JSON object matching this schema:',
      JSON.stringify(toJsonSchema(buildPromptGoalEvaluationSchema(criterionIds))),
    );
  }
  return instructions.join('\n');
}

export async function evaluatePromptGoal(params: {
  judge: PromptEvalJudge;
  contract: string;
  objective: string;
  acceptanceCriteria: PromptGoalAcceptanceCriterion[];
  evidence: unknown;
  candidateOutput: unknown;
}): Promise<{ scores: DecisionContractScore[]; summary: string }> {
  const criterionIds = params.acceptanceCriteria.map(({ id }) => id);
  const schema = buildPromptGoalEvaluationSchema(criterionIds);
  try {
    const raw = await params.judge.model.withStructuredOutput(
      schema,
      buildOrchestrationDecisionStructuredOutputOptions({ method: params.judge.method }),
    ).invoke([
      new SystemMessage(buildPromptGoalEvaluatorPrompt(params.judge.method, criterionIds)),
      new HumanMessage(JSON.stringify({
        contract: params.contract,
        objective: params.objective,
        acceptanceCriteria: params.acceptanceCriteria,
        evidence: params.evidence,
        candidateOutput: params.candidateOutput,
      })),
    ], params.judge.config);
    const evaluation = schema.parse(raw);
    return {
      scores: params.acceptanceCriteria.map((criterion) => {
        const result = evaluation.criteria[criterion.id];
        return {
          key: criterion.id,
          statement: criterion.statement,
          evaluator: 'llm-judge',
          score: result.met ? 1 : 0,
          comment: result.reason,
        };
      }),
      summary: evaluation.summary,
    };
  } catch (error) {
    throw new PromptEvalJudgeError(error);
  }
}
