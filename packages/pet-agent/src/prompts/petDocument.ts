import type { PetDocument } from '../types/petDocument';
import type { SystemPromptSection } from '../types/systemPrompt';

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
