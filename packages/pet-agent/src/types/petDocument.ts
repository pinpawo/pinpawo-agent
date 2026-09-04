import { createHash } from 'node:crypto';
import type { SystemPromptSection } from './systemPrompt';

export type PetDocument = {
  readonly content: string;
  readonly digest: string;
};

export function definePetDocument(params: { content: string }): PetDocument {
  const content = params.content.trim();
  if (!content) {
    throw new Error('Pet document must be a non-empty Markdown document');
  }
  return {
    content,
    digest: createHash('sha256').update(content).digest('hex'),
  };
}

export function petDocumentSystemPromptSection(document: PetDocument): SystemPromptSection {
  const content = document.content.replaceAll(']]>', ']]]]><![CDATA[>');
  return {
    id: 'pet:document',
    owner: 'pet',
    content: [
      '<pet_document role="root_context" source="PET.md" scope="pet">',
      'This is the Pet\'s canonical authored root document. Apply it within the framework\'s lifecycle, tool, and security contracts.',
      '<document format="markdown">',
      '<![CDATA[',
      content,
      ']]>',
      '</document>',
      '</pet_document>',
    ].join('\n'),
  };
}
