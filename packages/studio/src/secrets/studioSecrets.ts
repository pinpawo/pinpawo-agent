import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { PetCredentialBindings, PetCredentialSource } from 'pinpawo/host-runtime';
import type { PetDatabase } from '../pets/store/kysely';

export type StudioCredentialBinding = { petId: string; envName: string; secretId: string | null };
export type StudioCredentialBindingChange = { petId: unknown; envName: unknown; secretId: unknown; expectedSecretId: unknown };

export type StudioSecretMetadata = { secretId: string; name: string; createdAt: string; updatedAt: string };
/** Management never exposes decrypted values. Only the composing Runtime receives credentialSource. */
export type StudioSecrets = {
  status(): { unlocked: boolean };
  list(): Promise<StudioSecretMetadata[]>;
  put(input: { secretId: unknown; name: unknown; value: unknown }): Promise<StudioSecretMetadata>;
  bindings(petId: unknown): Promise<PetCredentialBindings>;
  compareAndSetBinding(input: StudioCredentialBindingChange): Promise<StudioCredentialBinding>;
  /** Unconditional full replacement; integrations should use compareAndSetBinding. */
  bind(input: { petId: unknown; bindings: unknown }): Promise<PetCredentialBindings>;
};
export class StudioSecretError extends Error {
  constructor(readonly code: 'invalid' | 'not_found' | 'locked' | 'unavailable' | 'conflict', message: string) {
    super(message);
    this.name = 'StudioSecretError';
  }
}
export type SecretDatabase = PetDatabase & {
  studio_secrets: { secret_id: string; name: string; encrypted_value: string; created_at: string; updated_at: string };
  studio_pet_credentials: { pet_id: string; env_name: string; secret_id: string };
};
const invalid = () => new StudioSecretError('invalid', 'Invalid Secret or credential binding.');
const unavailable = () => new StudioSecretError('unavailable', 'Studio Secret operation failed.');
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw invalid();
  return value;
}
function metadata(row: Pick<SecretDatabase['studio_secrets'], 'secret_id' | 'name' | 'created_at' | 'updated_at'>): StudioSecretMetadata {
  return { secretId: row.secret_id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** One Studio's database-backed Secret source. The deployment key is an explicit in-memory input, never read from env. */
export function createStudioSecrets(open: () => Promise<Kysely<SecretDatabase>>, masterKey?: Uint8Array): {
  management: StudioSecrets; credentialSource: PetCredentialSource;
} {
  if (masterKey && masterKey.byteLength !== 32) throw new StudioSecretError('invalid', 'Studio Secret key must contain exactly 32 bytes.');
  const key = masterKey ? Buffer.from(masterKey) : undefined;
  const requireKey = () => {
    if (!key) throw new StudioSecretError('locked', 'Studio Secrets are locked; configure the deployment key.');
    return key;
  };
  const protect = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run(); }
    catch (error) { if (error instanceof StudioSecretError) throw error; throw unavailable(); }
  };
  // SQLite uses one connection. Serialize binding reads with replacement transactions
  // so a local Runtime cannot observe the intermediate delete before insert.
  let pending: Promise<unknown> = Promise.resolve();
  const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    const next = pending.then(() => protect(run));
    pending = next.catch(() => undefined);
    return next;
  };
  const requirePet = async (db: Kysely<SecretDatabase>, petId: string) => {
    if (!await db.selectFrom('studio_pets').select('pet_id').where('pet_id', '=', petId).executeTakeFirst()) {
      throw new StudioSecretError('not_found', 'Pet does not exist.');
    }
  };
  const bindings = (pet: unknown) => serialize(async () => {
    const petId = id(pet), db = await open();
    await requirePet(db, petId);
    const rows = await db.selectFrom('studio_pet_credentials').select(['env_name', 'secret_id']).where('pet_id', '=', petId).execute();
    return Object.freeze(Object.fromEntries(rows.map(row => [row.env_name, row.secret_id])));
  });
  const management: StudioSecrets = {
    status: () => ({ unlocked: !!key }),
    list: () => protect(async () => (await (await open()).selectFrom('studio_secrets').select(['secret_id', 'name', 'created_at', 'updated_at']).orderBy('secret_id').execute()).map(metadata)),
    put: input => serialize(async () => {
      const secretId = id(input.secretId);
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80
        || typeof input.value !== 'string' || !input.value || Buffer.byteLength(input.value) > 65_536 || input.value.includes('\0')) throw invalid();
      // Bind ciphertext to its identifier with authenticated data.
      const nonce = randomBytes(12);
      const encrypt = createCipheriv('aes-256-gcm', requireKey(), nonce);
      encrypt.setAAD(Buffer.from(secretId));
      const ciphertext = Buffer.concat([encrypt.update(input.value, 'utf8'), encrypt.final()]);
      const encrypted = JSON.stringify({ v: 1, nonce: nonce.toString('base64'), tag: encrypt.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
      const name = input.name.trim();
      const now = new Date().toISOString();
      const db = await open();
      const row = await db.insertInto('studio_secrets').values({ secret_id: secretId, name, encrypted_value: encrypted, created_at: now, updated_at: now })
        .onConflict(c => c.column('secret_id').doUpdateSet({ name, encrypted_value: encrypted, updated_at: now }))
        .returning(['secret_id', 'name', 'created_at', 'updated_at']).executeTakeFirstOrThrow();
      return metadata(row);
    }),
    bindings,
    compareAndSetBinding: input => serialize(async () => {
      requireKey();
      const petId = id(input.petId);
      const envName = input.envName;
      if (typeof envName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw invalid();
      const secretId = input.secretId === null ? null : id(input.secretId);
      const expected = input.expectedSecretId === null ? null : id(input.expectedSecretId);
      const db = await open();
      // Validate references outside the write transaction. Foreign keys also guard
      // against disappearance before DML. Mutating transactions start with DML,
      // without first holding a SQLite read snapshot.
      await requirePet(db, petId);
      if (secretId !== null && !await db.selectFrom('studio_secrets').select('secret_id').where('secret_id', '=', secretId).executeTakeFirst()) {
        throw new StudioSecretError('not_found', 'Secret does not exist.');
      }
      const changed = await db.transaction().execute(async tx => {
        if (expected === null) {
          if (secretId === null) {
            // An absent -> absent operation is a conditional no-op, linearized by
            // this target-row check. It cannot remove a concurrent new binding.
            return !await tx.selectFrom('studio_pet_credentials').select('secret_id')
              .where('pet_id', '=', petId).where('env_name', '=', envName).executeTakeFirst();
          }
          const row = await tx.insertInto('studio_pet_credentials').values({ pet_id: petId, env_name: envName, secret_id: secretId })
            .onConflict(c => c.columns(['pet_id', 'env_name']).doNothing()).returning('secret_id').executeTakeFirst();
          return !!row;
        }
        const row = secretId === null
          ? await tx.deleteFrom('studio_pet_credentials').where('pet_id', '=', petId).where('env_name', '=', envName)
            .where('secret_id', '=', expected).returning('secret_id').executeTakeFirst()
          : await tx.updateTable('studio_pet_credentials').set({ secret_id: secretId }).where('pet_id', '=', petId).where('env_name', '=', envName)
            .where('secret_id', '=', expected).returning('secret_id').executeTakeFirst();
        return !!row;
      });
      if (!changed) throw new StudioSecretError('conflict', 'Pet credential binding changed; refresh its reference before retrying.');
      return { petId, envName, secretId };
    }),
    bind: input => serialize(async () => {
      requireKey();
      const petId = id(input.petId);
      if (!input.bindings || typeof input.bindings !== 'object' || Array.isArray(input.bindings)) throw invalid();
      const entries = Object.entries(input.bindings);
      for (const [name, ref] of entries) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw invalid();
        id(ref);
      }
      const db = await open();
      await db.transaction().execute(async tx => {
        await requirePet(tx, petId);
        for (const [, ref] of entries) {
          if (!await tx.selectFrom('studio_secrets').select('secret_id').where('secret_id', '=', ref as string).executeTakeFirst()) {
            throw new StudioSecretError('not_found', 'Secret does not exist.');
          }
        }
        await tx.deleteFrom('studio_pet_credentials').where('pet_id', '=', petId).execute();
        if (entries.length) await tx.insertInto('studio_pet_credentials').values(entries.map(([env_name, secret_id]) => ({ pet_id: petId, env_name, secret_id: secret_id as string }))).execute();
      });
      return Object.freeze(Object.fromEntries(entries)) as PetCredentialBindings;
    }),
  };
  const credentialSource: PetCredentialSource = {
    readBindings: bindings,
    resolve: ref => protect(async () => {
      const secretId = id(ref);
      const decryptionKey = requireKey();
      const row = await (await open()).selectFrom('studio_secrets').select('encrypted_value').where('secret_id', '=', secretId).executeTakeFirst();
      if (!row) throw new StudioSecretError('not_found', 'Secret does not exist.');
      const envelope = JSON.parse(row.encrypted_value);
      if (envelope.v !== 1) throw unavailable();
      const nonce = Buffer.from(envelope.nonce, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
      if (nonce.byteLength !== 12 || tag.byteLength !== 16) throw unavailable();
      const decipher = createDecipheriv('aes-256-gcm', decryptionKey, nonce);
      decipher.setAAD(Buffer.from(secretId));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    }),
  };
  return { management, credentialSource };
}
