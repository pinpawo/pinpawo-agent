import type { AgentActor } from '../../../types/agent';
import { ORCHESTRATOR_DECISION_SHARED_PREFIX } from './templates/sharedPrefix.prompt';

export function xmlTextBlock(tag: string, text: string, attrs = ''): string {
  const safeText = text.replaceAll(']]>', ']]]]><![CDATA[>');
  return [
    `<${tag}${attrs}>`,
    '<![CDATA[',
    safeText,
    ']]>',
    `</${tag}>`,
  ].join('\n');
}

export function indentXmlBlock(block: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  let inCdata = false;
  return block.split('\n').map((line) => {
    if (line.trim() === '<![CDATA[') {
      inCdata = true;
      return `${prefix}${line}`;
    }
    if (line.trim() === ']]>') {
      inCdata = false;
      return `${prefix}${line}`;
    }
    return inCdata ? line : `${prefix}${line}`;
  }).join('\n');
}

export function promptBlock(block: string | null | undefined, spaces: number): string {
  // A block owns its leading newline so optional template slots disappear cleanly.
  return block ? `\n${indentXmlBlock(block, spaces)}` : '';
}

export function buildDecisionConfig(
  actor: AgentActor,
  workdir?: string,
  runtimeEnvironment?: string,
): string {
  return [
    '[配置]',
    `角色：「${actor.name}」`,
    workdir ? `工作目录：${workdir}` : null,
    workdir ? '相对路径默认相对于工作目录；只有在工具显式指定其他目录时，才偏离这个目录。' : null,
    runtimeEnvironment ? runtimeEnvironment : null,
  ].filter((line) => line !== null).join('\n');
}

// Core decision prompt prefix shared by root decision prompts.
// Capability Planner owns short mode-specific prompts. Keep this synchronized with
// docs/design/agent-runtime/decision-prompt-prefix.md.
export function buildOrchestratorDecisionPromptPrefix(): string {
  return ORCHESTRATOR_DECISION_SHARED_PREFIX;
}
