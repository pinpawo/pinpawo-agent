import type { AgentActor } from '../../../types/agent';
import type { PetDocument } from '../../../types/petDocument';

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

export function appendPetDocument(
  systemPrompt: string,
  document?: PetDocument,
): string {
  if (!document) return systemPrompt;
  return [
    systemPrompt,
    '',
    '<pet_document role="root_context" source="PET.md" scope="pet">',
    'This is the Pet\'s canonical authored root document. Apply it throughout this model role within the framework\'s lifecycle, tool, and security contracts.',
    xmlTextBlock('document', document.content, ' format="markdown"'),
    '</pet_document>',
  ].join('\n');
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
