export type AgentEvalArea =
  | 'route_control'
  | 'capability_search'
  | 'delegation_control'
  | 'interruption_recovery'
  | 'permission_control'
  | 'context_synthesis'
  | 'structured_output'
  | 'entry_decision'
  | 'capability_decision'
  | 'outcome_decision'
  | 'capability_planning'
  | 'multi_task_flow';

export type AgentEvalDifficulty = 'easy' | 'medium' | 'hard';

export type AgentEvalCase<Input, Expected> = {
  id: string;
  name: string;
  suite: string;
  input: Input;
  expected: Expected;
  tags: AgentEvalArea[];
  metadata: {
    difficulty: AgentEvalDifficulty;
    reason: string;
    source: string;
    legacyName?: string;
  };
};

export type AgentEvalDataset<Input, Expected> = {
  name: string;
  description: string;
  cases: AgentEvalCase<Input, Expected>[];
  metadata: {
    owner: 'pet-agent' | 'local-agent';
    areas: AgentEvalArea[];
  };
};

export const AGENT_EVAL_AREAS: Record<AgentEvalArea, string> = {
  route_control: 'Decide whether the agent should answer directly or delegate work.',
  capability_search: 'Find and select domain capabilities when general tools are not the best fit.',
  delegation_control: 'Delegate the right amount of work without repeating completed tasks.',
  interruption_recovery: 'Resume interrupted or limit-reached work on the correct lane.',
  permission_control: 'Ask for, preserve, and apply user approvals safely.',
  context_synthesis: 'Use completed subagent context to answer instead of doing more work.',
  structured_output: 'Produce schema-compatible model outputs for orchestration internals.',
  entry_decision: 'Choose answer, direct task, or capability-aware planning at run entry.',
  capability_decision: 'Search and select the capability subagent for a current task.',
  outcome_decision: 'Evaluate a subagent announce and choose the next orchestration transition.',
  capability_planning: 'Plan capability execution boundaries and materialize the next task.',
  multi_task_flow: 'Complete goals across isolated task executions and handoffs.',
};
