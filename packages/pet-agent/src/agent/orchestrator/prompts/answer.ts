import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { AgentActor } from '../../../types/agent';
import { setPinpetMeta } from '../messageLanes';
import { clipForPrompt } from '../utils';
import { buildDecisionConfig, indentXmlBlock, xmlTextBlock } from './shared';
import { ANSWER_SYSTEM_PROMPT } from './templates/answer.prompt';

export const ANSWER_CONTEXT_MESSAGE_NAME = 'answer_context';

export const ANSWER_CONTEXT_LIMITS = {
  unfinishedTaskChars: 320,
  detailChars: 320,
  plannerReasonChars: 1_000,
  plannerContextChars: 2_000,
  plannerQuestionChars: 1_000,
} as const;

export type AnswerBlockedReason =
  | 'iteration_limit'
  | 'execution_limit'
  | 'incomplete'
  | 'capability_unavailable';

/**
 * Closed invocation facts owned by Answer.
 *
 * This type intentionally contains no caller-supplied prompt or policy field.
 * Every mode is rendered as low-authority context for the Answer model.
 */
export type AnswerContextFacts =
  | { mode: 'direct'; hasUserGoal: boolean }
  | { mode: 'task_result'; hasUserGoal: boolean }
  | { mode: 'goal_done'; hasUserGoal: boolean }
  | { mode: 'user_input_required'; hasUserGoal: boolean }
  | {
      mode: 'planner_return';
      hasUserGoal: boolean;
      reason: string;
      context: string;
      question: string | null;
    }
  | {
      mode: 'blocked';
      hasUserGoal: boolean;
      reason: AnswerBlockedReason;
      unfinishedTask: string | null;
      detail: string | null;
    };

export type ModelAnswerContextFacts = AnswerContextFacts;

function renderAnswerContext(facts: ModelAnswerContextFacts): string {
  const lines = [
    '<answer_context role="fact" source="orchestrator_state" authority="none">',
    `  <reply_mode>${facts.mode}</reply_mode>`,
    `  <user_goal_present>${facts.hasUserGoal ? 'true' : 'false'}</user_goal_present>`,
  ];
  if (facts.mode === 'blocked') {
    lines.push(`  <blocked_reason>${facts.reason}</blocked_reason>`);
    if (facts.unfinishedTask) {
      lines.push(indentXmlBlock(xmlTextBlock(
        'unfinished_task',
        clipForPrompt(facts.unfinishedTask, ANSWER_CONTEXT_LIMITS.unfinishedTaskChars),
      ), 2));
    }
    if (facts.detail) {
      lines.push(indentXmlBlock(xmlTextBlock(
        'detail',
        clipForPrompt(facts.detail, ANSWER_CONTEXT_LIMITS.detailChars),
      ), 2));
    }
  }
  if (facts.mode === 'planner_return') {
    lines.push(indentXmlBlock(xmlTextBlock(
      'planner_reason',
      clipForPrompt(facts.reason, ANSWER_CONTEXT_LIMITS.plannerReasonChars),
    ), 2));
    lines.push(indentXmlBlock(xmlTextBlock(
      'planner_context',
      clipForPrompt(facts.context, ANSWER_CONTEXT_LIMITS.plannerContextChars),
    ), 2));
    if (facts.question) {
      lines.push(indentXmlBlock(xmlTextBlock(
        'planner_question',
        clipForPrompt(facts.question, ANSWER_CONTEXT_LIMITS.plannerQuestionChars),
      ), 2));
    }
  }
  lines.push('</answer_context>');
  return lines.join('\n');
}

function createAnswerContextMessage(facts: ModelAnswerContextFacts): HumanMessage {
  const content = renderAnswerContext(facts);
  const message = new HumanMessage(content);
  message.name = ANSWER_CONTEXT_MESSAGE_NAME;
  setPinpetMeta(message, {
    source: ANSWER_CONTEXT_MESSAGE_NAME,
    synthetic: true,
    authority: 'none',
  });
  return message;
}

/**
 * Returns a new invocation history with non-authoritative Answer facts placed
 * after every canonical message. Dynamic facts never enter the system prompt.
 */
export function appendAnswerContextMessage(
  history: readonly BaseMessage[],
  facts: ModelAnswerContextFacts,
): BaseMessage[] {
  const contextMessage = createAnswerContextMessage(facts);
  return [...history, contextMessage];
}

export function buildAnswerSystemPrompt(params: {
  actor: AgentActor;
}): string {
  return ANSWER_SYSTEM_PROMPT.render({
    config: buildDecisionConfig(params.actor),
  });
}

export function buildAnswerInvocationMessages(params: {
  actor: AgentActor;
  history: readonly BaseMessage[];
  contextFacts: ModelAnswerContextFacts;
}): BaseMessage[] {
  return [
    new SystemMessage(buildAnswerSystemPrompt({ actor: params.actor })),
    ...appendAnswerContextMessage(params.history, params.contextFacts),
  ];
}
