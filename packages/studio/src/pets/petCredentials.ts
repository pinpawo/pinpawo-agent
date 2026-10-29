import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { PetCredentialSource } from 'pinpawo/host-runtime';
import type { PetStore } from './store/petStore';
import { StudioPetError } from './studioPets';

/** A credential as management sees it: never its value. */
export type StudioPetCredential = { envName: string; updatedAt: string };

/** Each Pet's own environment variables for the commands it runs (docs/design/studio/pet-credentials.md). */
export type StudioPetCredentials = {
  /** False without the Studio's key file: credentials can be listed but not set or used. */
  unlocked: () => boolean;
  list: (petId: unknown) => Promise<StudioPetCredential[]>;
  set: (input: { petId: unknown; envName: unknown; value: unknown }) => Promise<StudioPetCredential>;
  remove: (input: { petId: unknown; envName: unknown }) => Promise<{ removed: boolean }>;
};

export const PET_CREDENTIALS_KEY_BYTES = 32;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_VALUE_BYTES = 65_536;

function readEnvName(value: unknown): string {
  if (typeof value !== 'string' || !ENV_NAME.test(value)) {
    throw new StudioPetError('Credential name must be an environment variable name (letters, digits and "_", not starting with a digit).', 'invalid');
  }
  return value;
}

function readValue(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value) > MAX_VALUE_BYTES) {
    throw new StudioPetError('Credential value must be 1-65536 bytes of text without NUL.', 'invalid');
  }
  return value;
}

/**
 * Pet credentials in the Studio database, encrypted with the Studio's key.
 * Management never returns a value; only the composing Host decrypts, through
 * {@link StudioPetCredentialVault.source}, for the Pet whose turn is running.
 */
export class StudioPetCredentialVault implements StudioPetCredentials {
  private readonly key: Buffer | undefined;
  readonly source: PetCredentialSource;

  constructor(private readonly options: {
    store: () => Promise<PetStore>;
    /** The Studio's key; without it credentials are locked. */
    key?: Uint8Array;
  }) {
    if (options.key && options.key.byteLength !== PET_CREDENTIALS_KEY_BYTES) {
      throw new Error(`Studio credentials key must be ${PET_CREDENTIALS_KEY_BYTES} bytes.`);
    }
    this.key = options.key ? Buffer.from(options.key) : undefined;
    this.source = { environment: petId => this.environment(petId) };
  }

  unlocked(): boolean {
    return this.key !== undefined;
  }

  async list(petId: unknown): Promise<StudioPetCredential[]> {
    const store = await this.petStore(petId);
    return (await store.store.listCredentials(store.petId)).map(({ envName, updatedAt }) => ({ envName, updatedAt }));
  }

  async set(input: { petId: unknown; envName: unknown; value: unknown }): Promise<StudioPetCredential> {
    const envName = readEnvName(input.envName);
    const value = readValue(input.value);
    const key = this.requireKey();
    const { store, petId } = await this.petStore(input.petId);
    const updatedAt = new Date().toISOString();
    await store.setCredential({ petId, envName, encryptedValue: encrypt(key, aad(petId, envName), value), updatedAt });
    return { envName, updatedAt };
  }

  async remove(input: { petId: unknown; envName: unknown }): Promise<{ removed: boolean }> {
    const envName = readEnvName(input.envName);
    const { store, petId } = await this.petStore(input.petId);
    return { removed: await store.deleteCredential(petId, envName) };
  }

  /** Every variable of this Pet, decrypted. A Pet without credentials gets `{}`, even while locked. */
  private async environment(petId: string): Promise<Readonly<Record<string, string>>> {
    const { store } = await this.petStore(petId);
    const rows = await store.listCredentials(petId);
    if (rows.length === 0) return {};
    const key = this.requireKey();
    return Object.fromEntries(rows.map(row => [row.envName, decrypt(key, aad(row.petId, row.envName), row.encryptedValue)]));
  }

  private requireKey(): Buffer {
    if (!this.key) throw new StudioPetError('Studio credentials are locked: this Studio has no credentials key file.', 'locked');
    return this.key;
  }

  private async petStore(petId: unknown): Promise<{ store: PetStore; petId: string }> {
    const id = typeof petId === 'string' ? petId.trim() : '';
    const store = await this.options.store();
    if (!id || !await store.getPet(id)) throw new StudioPetError(`No Pet "${id}".`, 'not_found');
    return { store, petId: id };
  }
}

/** Binds a ciphertext to its row, so it cannot be moved to another Pet or variable. */
function aad(petId: string, envName: string): Buffer {
  return Buffer.from(JSON.stringify([petId, envName]));
}

function encrypt(key: Buffer, associated: Buffer, value: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(associated);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'),
  });
}

function decrypt(key: Buffer, associated: Buffer, envelope: string): string {
  const { v, nonce, tag, ciphertext } = JSON.parse(envelope) as Record<string, unknown>;
  if (v !== 1 || typeof nonce !== 'string' || typeof tag !== 'string' || typeof ciphertext !== 'string') {
    throw new Error('Unreadable credential envelope.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), { authTagLength: 16 });
  decipher.setAAD(associated);
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
