// Subagent iteration budget = soft model-call guard. createSubagent sets a high
// LangGraph recursionLimit so the guard can stop gracefully before the
// runtime breaker.
// Unified across lanes (P4 / #281). See docs/GUARD_DESIGN.md.
const SUBAGENT_MAX_ITERATIONS = 100;

export const CAPABILITY_SUBAGENT_MAX_ITERATIONS = SUBAGENT_MAX_ITERATIONS;
export const DEFAULT_ORCHESTRATOR_MAX_ITERATIONS = 25;

const ORCHESTRATOR_INTERNAL_AI_STREAM_NODE_NAMES = [
  'entryDecision',
  'capabilityPlanner',
] as const;

const ORCHESTRATOR_INTERNAL_AI_STREAM_NODE_SET = new Set<string>(
  ORCHESTRATOR_INTERNAL_AI_STREAM_NODE_NAMES,
);

export function isOrchestratorInternalAiStreamNode(node: string) {
  return ORCHESTRATOR_INTERNAL_AI_STREAM_NODE_SET.has(node);
}
