import type { PetDispatchPort, PetSessionPort } from 'pinpawo/host-runtime';

/** A Pet definition this Studio may create Pets from: how a Pet works, not who it is. */
export type StudioPetDefinition = {
  definitionId: string;
  /** The definition's default display name. */
  name: string;
};

/** One Pet instance as Studio records it. Its `petId` is the only id work is addressed to. */
export type StudioPet = {
  petId: string;
  definitionId: string;
  /** Display only; never used to address the Pet. */
  name: string;
  createdAt: string;
};

/** Studio-owned metadata used to target a currently live resident Pet. */
export type StudioPetRegistration = {
  petId: string;
  name: string;
  definitionId: string;
};

/**
 * What the composing Host returns for one assembled Pet. Studio core keeps
 * only the dispatch and session ports and closes the runtime when Studio
 * shuts down.
 */
export type StudioPetRuntime = {
  dispatch: PetDispatchPort;
  /** Exact-session observation and review; absent for dispatch-only Pets. */
  sessions?: PetSessionPort;
  close: () => Promise<void>;
};

/** Build the runtime for one Pet from its definition. Called once per Pet per Studio run. */
export type StudioPetAssembler = (pet: StudioPetRegistration) => Promise<StudioPetRuntime>;
