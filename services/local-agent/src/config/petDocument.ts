import { promises as fs } from 'node:fs';
import path from 'node:path';

import { definePetDocument, type PetDocument } from '@pinpawo/pet-agent';

export function resolveChatPetDocumentPath(workdir: string): string {
  return path.join(path.resolve(workdir), 'PET.md');
}

/** Read one Host-resolved PET.md path into the shared Pet domain contract. */
export async function loadPetDocumentFile(filePath: string): Promise<PetDocument | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`failed to read Pet document ${filePath}: ${(error as Error).message}`);
  }

  try {
    return definePetDocument({ content });
  } catch (error) {
    throw new Error(`invalid Pet document ${filePath}: ${(error as Error).message}`);
  }
}
