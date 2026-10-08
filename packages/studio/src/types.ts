import type { PetDispatchPort, PetSessionPort } from 'pinpawo/host-runtime';

/** Studio-owned metadata used to target a currently live resident Pet. */
export type StudioPetRegistration = {
  petId: string;
  name: string;
};

/** Studio combines its own registration with a borrowed host port. */
export type StudioPetBinding = {
  registration: StudioPetRegistration;
  dispatch: PetDispatchPort;
  /** Exact-session observation and review; absent for dispatch-only Pets. */
  sessions?: PetSessionPort;
};
