export const SYSTEM_POLICY_SOURCE = {
  FRAMEWORK: 'framework',
  CAPABILITY: 'capability',
  TOOLKIT: 'toolkit',
} as const;

export type SystemPolicySource = typeof SYSTEM_POLICY_SOURCE[keyof typeof SYSTEM_POLICY_SOURCE];

export type SystemPolicyInstruction = {
  readonly id: string;
  readonly source: SystemPolicySource;
  readonly owner?: string;
  readonly content: string;
};
