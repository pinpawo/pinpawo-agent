/** Presentation metadata returned by the local Capability management CLI. */
export type CapabilityMeta = {
  /** Unique stable identifier — matches AgentCapability.name */
  id: string;
  /** Human-readable display name (Chinese) */
  name: string;
  /** One-sentence description shown in settings */
  description: string;
  /** Optional presentation icon token. */
  icon: string;
  /** Optional presentation color token. */
  color: string;
  /** Whether the capability is enabled by default */
  defaultEnabled: boolean;
  /** True for capabilities shipped with the app bundle */
  builtIn: boolean;
};

export const BUILT_IN_CAPABILITY_IDS = Object.freeze([
  'explore',
  'capability_creator',
  'browser',
]);
