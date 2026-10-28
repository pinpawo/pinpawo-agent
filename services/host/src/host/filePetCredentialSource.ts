import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { PetCredentialBindings, PetCredentialSource } from './petCredentials';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}

/**
 * Opt-in local adapter. Provision outside ordinary Studio APIs; use atomic replacement
 * with mode 0600 in an owner-only directory. Values live only here, never in Pet definitions.
 * Every read reopens the file, so new commands see replacements without Host restart.
 */
export class FilePetCredentialSource implements PetCredentialSource {
  constructor(private readonly path: string) {}

  private async read(): Promise<Record<string, unknown>> {
    try {
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o077) !== 0
          || (process.getuid && stat.uid !== process.getuid())) throw new Error();
        return record(JSON.parse(await file.readFile('utf8')));
      } finally { await file.close(); }
    } catch {
      throw new Error('Pet credential source is unavailable or invalid.');
    }
  }

  async readBindings(petId: string): Promise<PetCredentialBindings> {
    const bindings = record((await this.read()).bindings);
    if (!Object.hasOwn(bindings, petId)) throw new Error('Pet credential binding is missing.');
    const entries = record(bindings[petId]);
    if (Object.values(entries).some((ref) => typeof ref !== 'string')) throw new Error('Pet credential binding is invalid.');
    return Object.freeze({ ...entries }) as PetCredentialBindings;
  }

  async resolve(ref: string): Promise<string> {
    const values = record((await this.read()).values);
    if (!Object.hasOwn(values, ref) || typeof values[ref] !== 'string') throw new Error('Pet credential reference is missing.');
    return values[ref];
  }
}
