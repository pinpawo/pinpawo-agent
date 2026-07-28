import {
  DATASET_DESCRIPTION,
  DATASET_NAME,
  Example,
  examples,
} from '../dataset.ts';
import {
  AgentEvalArea,
  AgentEvalCase,
  AgentEvalDataset,
  AgentEvalDifficulty,
} from './types.ts';

type OrchestratorRouteInput = Example['inputs'];
type OrchestratorRouteExpected = Example['outputs'];

const SOURCE_FILE = 'packages/pet-agent/evals/dataset.ts';

function inferAreas(example: Example): AgentEvalArea[] {
  const areas = new Set<AgentEvalArea>(['route_control']);

  if (
    example.inputs.capability_pack
    || example.inputs.allowed_capability_names
    || example.outputs.expected_mode === 'capability'
  ) {
    areas.add('capability_discovery');
  }

  if (
    example.inputs.completed_results
    || example.inputs.progress_results
    || example.inputs.completed_tasks
    || example.outputs.expected_phase === 'after_subagent'
  ) {
    areas.add('delegation_control');
  }

  if (
    example.inputs.completed_results
    || example.outputs.expected_route === 'answer'
  ) {
    areas.add('context_synthesis');
  }

  if (
    example.inputs.resume_progress_result
    || example.inputs.resume_progress_lane
    || example.name.includes('resume')
  ) {
    areas.add('interruption_recovery');
  }

  return [...areas];
}

function inferDifficulty(example: Example): AgentEvalDifficulty {
  const areas = inferAreas(example);
  if (areas.includes('interruption_recovery')) return 'hard';
  if (
    areas.includes('capability_discovery')
    || areas.includes('delegation_control')
  ) {
    return 'medium';
  }
  return 'easy';
}

function toCase(example: Example): AgentEvalCase<OrchestratorRouteInput, OrchestratorRouteExpected> {
  return {
    id: `${DATASET_NAME}.${example.name}`,
    name: example.name,
    suite: DATASET_NAME,
    input: example.inputs,
    expected: example.outputs,
    tags: inferAreas(example),
    metadata: {
      difficulty: inferDifficulty(example),
      reason: example.outputs.reason,
      source: SOURCE_FILE,
      legacyName: example.name,
    },
  };
}

export const orchestratorRouteDataset: AgentEvalDataset<
  OrchestratorRouteInput,
  OrchestratorRouteExpected
> = {
  name: DATASET_NAME,
  description: DATASET_DESCRIPTION,
  cases: examples.map(toCase),
  metadata: {
    owner: 'pet-agent',
    areas: [
      'route_control',
      'capability_discovery',
      'delegation_control',
      'interruption_recovery',
      'context_synthesis',
    ],
  },
};
