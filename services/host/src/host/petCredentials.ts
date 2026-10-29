import { AsyncLocalStorage } from 'node:async_hooks';

/** The environment variables one Pet instance's commands receive. Supplied by the composing Host, never by tool arguments. */
export interface PetCredentialSource {
  environment(petId: string): Promise<Readonly<Record<string, string>>>;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const identities = new AsyncLocalStorage<{ petId: string; active: boolean }>();

/** The resident turn runner binds its Pet here for interactive, dispatch and resumed turns. */
export async function withPetExecutionIdentity<T>(petId: string, run: () => Promise<T>): Promise<T> {
  const identity = { petId, active: true };
  return identities.run(identity, async () => {
    try { return await run(); } finally { identity.active = false; }
  });
}

/** Resolve only for the Pet whose turn is running; there is no Session or tool-input fallback. */
export async function resolvePetCredentialEnvironment(source: PetCredentialSource): Promise<Readonly<Record<string, string>>> {
  const identity = identities.getStore();
  if (!identity?.active) throw new Error('Pet credentials require an active Pet turn.');
  try {
    const environment = await source.environment(identity.petId);
    const env: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(environment)) {
      if (!ENV_NAME.test(name) || typeof value !== 'string' || value.includes('\0')) throw new Error();
      env[name] = value;
    }
    if (!identity.active) throw new Error();
    return Object.freeze(env);
  } catch {
    // The source's error may carry a credential value; keep no cause.
    throw new Error('Pet credential resolution failed; command was not started.');
  }
}
