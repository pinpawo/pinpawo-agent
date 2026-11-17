import { AsyncLocalStorage } from 'node:async_hooks';

/** Opaque domain reference supplied by an admitted Host caller, never by tool arguments. */
export type PetInvocationScope = Readonly<{ namespace: string; id: string }>;
export type PetInvocationContext = Readonly<{
  petId: string;
  dispatchId: string;
  sessionId?: string;
  scope?: PetInvocationScope;
}>;

const invocations = new AsyncLocalStorage<{ active: boolean; value: PetInvocationContext }>();

export function copyPetInvocationScope(scope: PetInvocationScope): PetInvocationScope {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || Object.keys(scope).some((key) => key !== 'namespace' && key !== 'id')
    || typeof scope.namespace !== 'string' || !scope.namespace.trim()
    || typeof scope.id !== 'string' || !scope.id.trim()) {
    throw new Error('Invocation scope requires a namespace and id.');
  }
  return Object.freeze({ namespace: scope.namespace, id: scope.id });
}

/** Read only while this admitted invocation is executing; no Session fallback. */
export function readPetInvocationContext(): PetInvocationContext | undefined {
  const entry = invocations.getStore();
  return entry?.active ? entry.value : undefined;
}

export async function withPetInvocationContext<T>(
  context: PetInvocationContext,
  run: () => Promise<T>,
): Promise<T> {
  const entry = { active: true, value: Object.freeze({
    petId: context.petId,
    dispatchId: context.dispatchId,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.scope ? { scope: copyPetInvocationScope(context.scope) } : {}),
  }) };
  return invocations.run(entry, async () => {
    try { return await run(); } finally { entry.active = false; }
  });
}

/** Interactive roots must not inherit a caller's one-way dispatch attribution. */
export function withoutPetInvocationContext<T>(run: () => T): T {
  return invocations.exit(run);
}
