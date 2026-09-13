import type { PetDocument } from '../types/petDocument';
import type { SystemPromptSection } from '../types/systemPrompt';

export function petDocumentSystemPromptSection(document: PetDocument): SystemPromptSection {
  const content = document.content.replaceAll(']]>', ']]]]><![CDATA[>');
  return {
    id: 'pet:document',
    owner: 'pet',
    content: [
      '<pet_document role="root_context" source="PET.md" scope="pet">',
      'This document defines your role and working instructions. Follow it within the available tools and applicable safety requirements.',
      '<document format="markdown">',
      '<![CDATA[',
      content,
      ']]>',
      '</document>',
      '</pet_document>',
    ].join('\n'),
  };
}
