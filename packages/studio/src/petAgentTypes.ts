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
