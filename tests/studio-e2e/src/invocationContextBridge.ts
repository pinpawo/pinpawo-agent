import type { CreateResidentPetHostOptions } from '../../../services/host/src/host/runtimeContext';
import type { StudioContextProvider } from '../../../packages/studio/src/studioContract';

type Resolver = NonNullable<CreateResidentPetHostOptions['resolveInvocationContext']>;

/** Connect prebuilt test Hosts to the owning Studio's live provider registry. */
export function createInvocationContextBridge() {
  let resolver: StudioContextProvider | undefined;
  return {
    resolveInvocationContext: (async (target) => {
      if (!resolver) throw new Error('The Studio invocation-context resolver is not connected.');
      return await resolver(target);
    }) satisfies Resolver,
    onPreparedContextResolver: (prepared: StudioContextProvider) => { resolver = prepared; },
  };
}
