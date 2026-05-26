import type { AgentActor } from './agent';

export type PetAgentStartupMode = 'standby' | 'lazy' | 'disabled';

export type PetAgentStatus =
  | 'disabled'
  | 'loading'
  | 'standby'
  | 'active'
  | 'degraded'
  | 'unavailable';

export type PetAgentCapabilitySummary = {
  name: string;
  description: string;
  available: boolean;
  reason?: string | null;
};

export type StudioAgent = AgentActor & {
  role?: string | null;
  serviceSummary?: string | null;
  startupMode?: PetAgentStartupMode;
  status?: PetAgentStatus;
  capabilities?: PetAgentCapabilitySummary[];
};

export type StudioContext = {
  studioId: string;
  ownerUserId: string | null;
  defaultPetId?: string | null;
  agents: StudioAgent[];
};
