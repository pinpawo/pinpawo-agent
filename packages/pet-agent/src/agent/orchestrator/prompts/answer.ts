import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { AgentActor } from '../../../types/agent';
import { getPinpetMeta, setPinpetMeta } from '../messageLanes';
import type { UserGoal } from '../types';
import { clipForPrompt } from '../utils';
import { buildRunUserGoalContext } from './context';
import { buildDecisionConfig, indentXmlBlock, xmlTextBlock } from './shared';
import { ANSWER_SYSTEM_PROMPT } from './templates/answer.prompt';

export const ANSWER_INPUT_MESSAGE_NAME = 'answer_input';

export const ANSWER_CONTEXT_LIMITS = {
  unfinishedTaskChars: 320,
  detailChars: 320,
  awaitingUserInputChars: 2_000,
} as const;

export type AnswerBlockedReason =
  | 'iteration_limit'
  | 'execution_limit'
  | 'incomplete'
  | 'capability_unavailable'
  | 'planner_checkpoint_missing';

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
  | {
      mode: 'user_input_required';
      hasUserGoal: boolean;
      context: string | null;
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
  if (facts.mode === 'user_input_required' && facts.context) {
    lines.push(indentXmlBlock(xmlTextBlock(
      'awaiting_user_input_context',
      clipForPrompt(facts.context, ANSWER_CONTEXT_LIMITS.awaitingUserInputChars),
    ), 2));
  }
  lines.push('</answer_context>');
  return lines.join('\n');
}

function renderAnswerInput(
  userGoal: UserGoal | null | undefined,
  facts: ModelAnswerContextFacts,
): string {
  return [
    '<answer_input role="fact" source="orchestrator_state" authority="none">',
    indentXmlBlock(buildRunUserGoalContext(userGoal ?? null), 2),
    indentXmlBlock(renderAnswerContext(facts), 2),
    '</answer_input>',
  ].join('\n');
}

function createAnswerInputMessage(
  userGoal: UserGoal | null | undefined,
  facts: ModelAnswerContextFacts,
): HumanMessage {
  const content = renderAnswerInput(userGoal, facts);
  const message = new HumanMessage(content);
  message.name = ANSWER_INPUT_MESSAGE_NAME;
  setPinpetMeta(message, {
    source: ANSWER_INPUT_MESSAGE_NAME,
    synthetic: true,
    authority: 'none',
  });
  return message;
}

/**
 * Returns a new invocation history with one non-authoritative Answer input
 * placed after every canonical message. Dynamic facts never enter the system
 * prompt or masquerade as separate user turns.
 */
export function appendAnswerInputMessage(
  history: readonly BaseMessage[],
  userGoal: UserGoal | null | undefined,
  facts: ModelAnswerContextFacts,
): BaseMessage[] {
  const inputMessage = createAnswerInputMessage(userGoal, facts);
  const canonicalHistory = history.filter((message) => !(
    message.name === ANSWER_INPUT_MESSAGE_NAME
    || getPinpetMeta(message).source === ANSWER_INPUT_MESSAGE_NAME
  ));
  return [...canonicalHistory, inputMessage];
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
  userGoal?: UserGoal | null;
  contextFacts: ModelAnswerContextFacts;
}): BaseMessage[] {
  return [
    new SystemMessage(buildAnswerSystemPrompt({ actor: params.actor })),
    ...appendAnswerInputMessage(params.history, params.userGoal, params.contextFacts),
  ];
}
