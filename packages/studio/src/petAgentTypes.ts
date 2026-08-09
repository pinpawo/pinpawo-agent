import type { AgentActor } from '@pinpawo/pet-agent';

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
  /**
   * Static dependency resolution against the configured Toolkit inventory.
   * Toolkit runtime availability is evaluated for each async invoke generation.
   */
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
