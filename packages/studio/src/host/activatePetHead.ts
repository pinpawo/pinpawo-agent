import type { Studio, StudioDispatchQueue, StudioModelEndpoint } from '../studioContract';
import type { StudioPetRegistration } from '../types';
import { bindPetHeadChannel, createPetHead, readHeadDispatchQueueSnapshot, type PetHeadChannelOperations } from './petHead';
import { createHeadModel, type HeadDecisionDiagnostic } from './petHeadModel';
import { observeHeadRun } from './petHeadProgress';

/** Attach one Head for this PetInstance activation, using its existing lifetime. */
export function activatePetHead(input: {
  pet: StudioPetRegistration;
  description?: string;
  channel: PetHeadChannelOperations;
  subscribe: Studio['subscribe'];
  listDispatchQueues: () => StudioDispatchQueue[];
  resolveModel: () => StudioModelEndpoint;
  onDiagnostic?: (event: HeadDecisionDiagnostic) => void;
}, signal: AbortSignal): () => void {
  signal.throwIfAborted();
  const { pet, description, subscribe } = input;
  const channel = bindPetHeadChannel(pet.channelId, input.channel, subscribe);
  const readProgressSession = channel.readProgressSession;
  const model = createHeadModel(input.resolveModel, { onDiagnostic: input.onDiagnostic });
  const observation = observeHeadRun(subscribe, pet.petId, pet.channelId, signal);
  let unsubscribe: () => void;
  try {
    const handleMessage = createPetHead({
      pet,
      ...(description ? { description } : {}),
      channel,
      readScheduling: () => readHeadDispatchQueueSnapshot(pet.petId, pet.channelId, input.listDispatchQueues()),
      ...(readProgressSession ? { progress: {
        readRun: observation.read,
        snapshot: (sessionId, signal, isCurrent) => readProgressSession(pet.petId, sessionId, signal, isCurrent),
        compose: model.composeReply,
      } } : {}),
      decide: model.decide,
    });
    unsubscribe = channel.subscribe(message => handleMessage(message, signal));
  } catch (error) {
    // PetInstance will abort on activation failure, but never received a
    // disposer. Release the subscription already registered by the Head.
    observation.close();
    throw error;
  }
  return () => {
    try { unsubscribe(); }
    finally { observation.close(); }
  };
}
