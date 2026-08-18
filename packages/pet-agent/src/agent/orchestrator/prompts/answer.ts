import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { AgentActor } from '../../../types/agent';
import {
  MAX_HANDOFF_ARTIFACT_PREVIEW_LENGTH,
  MAX_HANDOFF_ARTIFACT_TITLE_LENGTH,
  MAX_HANDOFF_ARTIFACT_URI_LENGTH,
  type HandOffArtifactRef,
} from '../artifacts/handoff';
import { getPinpetMeta, setPinpetMeta } from '../messageLanes';
import type { UserRequest } from '../types';
import { clipForPrompt } from '../utils';
import { buildRunUserRequestContext } from './context';
import { buildDecisionConfig, indentXmlBlock, xmlTextBlock } from './shared';
import { ANSWER_SYSTEM_PROMPT } from './templates/answer.prompt';
import { ENTRY_ANSWER_SYSTEM_PROMPT } from './templates/entryAnswer.prompt';

export const ANSWER_INPUT_MESSAGE_NAME = 'answer_input';

export const ANSWER_CONTEXT_LIMITS = {
  unfinishedTaskChars: 320,
  detailChars: 320,
  awaitingUserInputChars: 2_000,
} as const;

export type AnswerAcceptedResult = {
  task: string;
  result: string;
  artifactRefs: readonly HandOffArtifactRef[];
};

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
type AnswerContextBaseFacts = {
  hasUserRequest: boolean;
  acceptedResults: readonly AnswerAcceptedResult[];
};

export type AnswerContextFacts = AnswerContextBaseFacts & (
  | { mode: 'direct' }
  | {
      mode: 'goal_done';
    }
  | {
      mode: 'user_input_required';
      context: string | null;
    }
  | {
      mode: 'blocked';
      reason: AnswerBlockedReason;
      unfinishedTask: string | null;
      detail: string | null;
    }
);

export type ModelAnswerContextFacts = AnswerContextFacts;

function renderAcceptedResultArtifacts(refs: readonly HandOffArtifactRef[]): string | null {
  if (refs.length === 0) return null;
  const lines = ['<artifacts>'];
  for (const ref of refs) {
    lines.push('  <artifact>');
    lines.push(indentXmlBlock(xmlTextBlock('id', ref.id), 4));
    lines.push(indentXmlBlock(xmlTextBlock(
      'uri',
      clipForPrompt(ref.uri, MAX_HANDOFF_ARTIFACT_URI_LENGTH),
    ), 4));
    lines.push(indentXmlBlock(xmlTextBlock('capability', clipForPrompt(ref.capabilityId, 160)), 4));
    lines.push(`    <kind>${ref.kind}</kind>`);
    if (ref.mimeType) {
      lines.push(indentXmlBlock(xmlTextBlock('mime_type', clipForPrompt(ref.mimeType, 80)), 4));
    }
    if (ref.title) {
      lines.push(indentXmlBlock(xmlTextBlock(
        'title',
        clipForPrompt(ref.title, MAX_HANDOFF_ARTIFACT_TITLE_LENGTH),
      ), 4));
    }
    if (ref.preview) {
      lines.push(indentXmlBlock(xmlTextBlock(
        'preview',
        clipForPrompt(ref.preview, MAX_HANDOFF_ARTIFACT_PREVIEW_LENGTH),
      ), 4));
    }
    lines.push('  </artifact>');
  }
  lines.push('</artifacts>');
  return lines.join('\n');
}

function renderAcceptedResults(results: readonly AnswerAcceptedResult[]): string | null {
  if (results.length === 0) return null;
  const lines = ['<accepted_results>'];
  for (const [index, result] of results.entries()) {
    lines.push(`  <accepted_result order="${(index + 1).toString()}">`);
    lines.push(indentXmlBlock(xmlTextBlock('task', result.task), 4));
    lines.push(indentXmlBlock(xmlTextBlock('result', result.result, ' format="markdown" role="data"'), 4));
    const artifacts = renderAcceptedResultArtifacts(result.artifactRefs);
    if (artifacts) lines.push(indentXmlBlock(artifacts, 4));
    lines.push('  </accepted_result>');
  }
  lines.push('</accepted_results>');
  return lines.join('\n');
}

function renderAnswerContext(facts: ModelAnswerContextFacts): string {
  const lines = [
    '<answer_context role="fact" source="orchestrator_state" authority="none">',
    `  <reply_mode>${facts.mode}</reply_mode>`,
    `  <user_request_present>${facts.hasUserRequest ? 'true' : 'false'}</user_request_present>`,
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
  const acceptedResults = renderAcceptedResults(facts.acceptedResults);
  if (acceptedResults) lines.push(indentXmlBlock(acceptedResults, 2));
  lines.push('</answer_context>');
  return lines.join('\n');
}

function renderAnswerInput(
  userRequest: UserRequest | null | undefined,
  facts: ModelAnswerContextFacts,
): string {
  return [
    '<answer_input role="fact" source="orchestrator_state" authority="none">',
    indentXmlBlock(buildRunUserRequestContext(userRequest ?? null), 2),
    indentXmlBlock(renderAnswerContext(facts), 2),
    '</answer_input>',
  ].join('\n');
}

function createAnswerInputMessage(
  userRequest: UserRequest | null | undefined,
  facts: ModelAnswerContextFacts,
): HumanMessage {
  const content = renderAnswerInput(userRequest, facts);
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
  userRequest: UserRequest | null | undefined,
  facts: ModelAnswerContextFacts,
): BaseMessage[] {
  const inputMessage = createAnswerInputMessage(userRequest, facts);
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

export function buildEntryAnswerSystemPrompt(params: {
  actor: AgentActor;
}): string {
  return ENTRY_ANSWER_SYSTEM_PROMPT.render({
    config: buildDecisionConfig(params.actor),
  });
}

/**
 * Answer is a closer: it runs only after a decision has been made, in
 * goal_done / blocked / user_input_required mode, and everything it must deliver
 * is already projected into <answer_input>.
 *
 * It deliberately receives no conversation history. Every past turn left a
 * near-duplicate pair in the main conversation — the subagent handoff and the
 * reply this node wrote about that handoff — so history showed the model its own
 * restatements and taught it to restate again. Measured at 68%/71%/100%
 * similarity across one session. The facts block is the whole input.
 */
export function buildAnswerInvocationMessages(params: {
  actor: AgentActor;
  userRequest?: UserRequest | null;
  contextFacts: ModelAnswerContextFacts;
}): BaseMessage[] {
  return [
    new SystemMessage(buildAnswerSystemPrompt({ actor: params.actor })),
    ...appendAnswerInputMessage([], params.userRequest, params.contextFacts),
  ];
}
