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
import { setPinpetMeta } from '../messageLanes';
import type { UserRequest } from '../types';
import { clipForPrompt } from '../utils';
import { buildRunUserRequestContext } from './context';
import { buildDecisionConfig, indentXmlBlock, xmlTextBlock } from './shared';
import { RESULT_SYNTHESIS_SYSTEM_PROMPT } from './templates/resultSynthesis.prompt';

export const RESULT_SYNTHESIS_INPUT_MESSAGE_NAME = 'result_synthesis_input';

export type ResultSynthesisAcceptedResult = {
  task: string;
  result: string;
  artifactRefs: readonly HandOffArtifactRef[];
};

function renderArtifacts(refs: readonly HandOffArtifactRef[]): string | null {
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

function renderAcceptedResults(results: readonly ResultSynthesisAcceptedResult[]): string {
  const lines = ['<accepted_results>'];
  for (const [index, result] of results.entries()) {
    lines.push(`  <accepted_result order="${(index + 1).toString()}">`);
    lines.push(indentXmlBlock(xmlTextBlock('task', result.task), 4));
    lines.push(indentXmlBlock(xmlTextBlock('result', result.result, ' format="markdown" role="data"'), 4));
    const artifacts = renderArtifacts(result.artifactRefs);
    if (artifacts) lines.push(indentXmlBlock(artifacts, 4));
    lines.push('  </accepted_result>');
  }
  lines.push('</accepted_results>');
  return lines.join('\n');
}

function buildResultSynthesisInput(
  userRequest: UserRequest | null | undefined,
  acceptedResults: readonly ResultSynthesisAcceptedResult[],
): string {
  return [
    '<result_synthesis_input role="fact" source="orchestrator_state" authority="none">',
    indentXmlBlock(buildRunUserRequestContext(userRequest ?? null), 2),
    indentXmlBlock(renderAcceptedResults(acceptedResults), 2),
    '</result_synthesis_input>',
  ].join('\n');
}

export function buildResultSynthesisInvocationMessages(params: {
  actor: AgentActor;
  userRequest?: UserRequest | null;
  acceptedResults: readonly ResultSynthesisAcceptedResult[];
}): BaseMessage[] {
  const input = new HumanMessage(buildResultSynthesisInput(
    params.userRequest,
    params.acceptedResults,
  ));
  input.name = RESULT_SYNTHESIS_INPUT_MESSAGE_NAME;
  setPinpetMeta(input, {
    source: RESULT_SYNTHESIS_INPUT_MESSAGE_NAME,
    synthetic: true,
    authority: 'none',
  });
  return [
    new SystemMessage(RESULT_SYNTHESIS_SYSTEM_PROMPT.render({
      config: buildDecisionConfig(params.actor),
    })),
    input,
  ];
}
