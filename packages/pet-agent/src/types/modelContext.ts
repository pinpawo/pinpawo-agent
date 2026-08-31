export const SYSTEM_POLICY_TARGET = {
  ENTRY_ANSWER: 'entry_answer',
  ANSWER: 'answer',
  CAPABILITY_PLANNER: 'capability_planner',
  CAPABILITY: 'capability',
  AUTO_REVIEW: 'auto_review',
  CAPABILITY_ROUTING_MANIFEST: 'capability_routing_manifest',
  CONTEXT_COMPACTION: 'context_compaction',
} as const;

export type SystemPolicyTarget = typeof SYSTEM_POLICY_TARGET[keyof typeof SYSTEM_POLICY_TARGET];

export const SYSTEM_POLICY_SOURCE = {
  FRAMEWORK: 'framework',
  HOST: 'host',
  CAPABILITY: 'capability',
  TOOLKIT: 'toolkit',
  PROVIDER_PROTOCOL: 'provider_protocol',
} as const;

export type SystemPolicySource = typeof SYSTEM_POLICY_SOURCE[keyof typeof SYSTEM_POLICY_SOURCE];

export type SystemPolicyInstruction = {
  readonly id: string;
  readonly source: SystemPolicySource;
  readonly owner?: string;
  readonly content: string;
};

type SystemPolicyRequestBase = {
  readonly instructions: readonly SystemPolicyInstruction[];
};

export type SystemPolicyRequest = SystemPolicyRequestBase & (
  | {
      readonly target: typeof SYSTEM_POLICY_TARGET.CAPABILITY_PLANNER;
      readonly variant: 'entry' | 'boundary';
    }
  | {
      readonly target: Exclude<
        SystemPolicyTarget,
        typeof SYSTEM_POLICY_TARGET.CAPABILITY_PLANNER
      >;
      readonly variant?: never;
    }
);
