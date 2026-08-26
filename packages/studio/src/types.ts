import type { PetDispatchPort } from 'pinpawo/host-runtime';

/** Studio-owned metadata used to target a currently live resident Pet. */
export type StudioPetRegistration = {
  petId: string;
  name: string;
  role?: string | null;
  serviceSummary?: string | null;
};

/** Studio combines its own registration with a borrowed local-agent port. */
export type StudioPetBinding = {
  registration: StudioPetRegistration;
  dispatch: PetDispatchPort;
};
