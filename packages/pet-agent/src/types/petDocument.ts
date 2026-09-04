import { createHash } from 'node:crypto';

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
