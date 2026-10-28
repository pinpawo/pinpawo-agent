import { AsyncLocalStorage } from 'node:async_hooks';

/** Host-owned references; never supplied by model tool arguments. */
export type PetCredentialBindings = Readonly<Record<string, string>>;

/** One configured source owns both instance bindings and opaque credential references. */
export interface PetCredentialSource {
  readBindings(petId: string): Promise<PetCredentialBindings>;
  resolve(ref: string): Promise<string>;
}

const identities = new AsyncLocalStorage<{ petId: string; active: boolean }>();

/** Internal admission boundary shared by interactive, dispatch and resumed turns. */
export async function withPetExecutionIdentity<T>(petId: string, run: () => Promise<T>): Promise<T> {
  const identity = { petId, active: true };
  return identities.run(identity, async () => {
    try { return await run(); } finally { identity.active = false; }
  });
}

/** Resolve only for the admitted instance; do not recover identity from Session or tool input. */
export async function resolvePetCredentialEnvironment(source: PetCredentialSource): Promise<Readonly<Record<string, string>>> {
  const identity = identities.getStore();
  if (!identity?.active || !identity.petId.trim()) throw new Error('Pet credentials require an active instance execution.');
  try {
    const bindings = await source.readBindings(identity.petId);
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw new Error();
    const env: Record<string, string> = Object.create(null);
    for (const [name, ref] of Object.entries(bindings)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof ref !== 'string' || !ref.trim()) throw new Error();
      const value = await source.resolve(ref);
      if (typeof value !== 'string' || value.includes('\0')) throw new Error();
      env[name] = value;
    }
    if (!identity.active) throw new Error();
    return Object.freeze(env);
  } catch {
    // Provider exceptions may contain credential values or private paths. No cause is retained.
    throw new Error('Pet credential resolution failed; command was not started.');
  }
}
