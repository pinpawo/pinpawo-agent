import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { searchCapabilities } from '../../src/agent/orchestrator/capabilitySearch.ts';
import {
  buildCapabilityDecisionInput,
  buildCapabilityDecisionSystemPrompt,
  buildCapabilityDecisionAvailableExecutorsContext,
} from '../../src/agent/orchestrator/prompts.ts';
import {
  CAPABILITY_UNAVAILABLE_SELECTION,
  buildCapabilityDecisionOutputInstruction,
  buildCapabilityDecisionSchema,
  buildOrchestrationDecisionStructuredOutputOptions,
} from '../../src/agent/orchestrator/schemas.ts';
import type { AgentModels } from '../../src/types/agent.ts';
import {
  defineInstructionDocument,
  type AgentCapability,
} from '../../src/types/capability.ts';
import { scoreCapabilityDecision } from '../decision-contract-scorers.ts';
import {
  capabilityDecisionBasicsDataset,
  type CapabilityDecisionBasicsInput,
} from '../datasets/capability-decision-basics.ts';
import { writeLangfuseEvalResult, type LangfuseEvalScore } from './langfuse-eval-writer.ts';
import { createDecisionEvalModel } from './decision-eval-model.ts';
import { resolveLangfuseConfig } from './langfuse-api.ts';

const actor = {
  petId: 'eval-pet',
  userId: 'eval-user',
  name: 'route-decision-eval',
  personality: null,
  stage: null,
  species: null,
};

function capabilities(input: CapabilityDecisionBasicsInput): AgentCapability[] {
  return [
    ...input.availableCapabilities.map((item) => ({
      name: item.name,
      description: `${item.description} Keywords: ${item.keywords.join('|')}`,
      uses: [],
      instructions: defineInstructionDocument({
        content: `Execute the ${item.name} capability.`,
      }),
    })),
    ...(input.includeGeneralCapability ? [{
      name: 'general',
      description: 'Handle general tasks that do not require a more specific Capability.',
      uses: [],
      instructions: defineInstructionDocument({
        content: 'Execute the general capability.',
      }),
    }] : []),
  ];
}

function mockModel(selection: string): AgentModels['act'] {
  return {
    invoke: async () => new AIMessage(''),
    withStructuredOutput: () => ({ invoke: async () => ({ selection }) }),
  } as unknown as AgentModels['act'];
}

function capabilitySearchQuery(input: CapabilityDecisionBasicsInput): string {
  return [input.task, input.contextSummary]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item))
    .join(' | ');
}

async function runCase(testCase: typeof capabilityDecisionBasicsDataset.cases[number], useLlm: boolean) {
  const input = testCase.input;
  const capabilityList = capabilities(input);
  const query = capabilitySearchQuery(input);
  const candidates = searchCapabilities(query, capabilityList);
  const generalCapability = capabilityList.find(({ name }) => name === 'general');
  const decisionCandidates = generalCapability
    && !candidates.some(({ name }) => name === generalCapability.name)
    ? [
        ...candidates,
        {
          name: generalCapability.name,
          description: generalCapability.description,
          score: 0,
          matchedTerms: ['planner-default'],
        },
      ]
    : candidates;
  const methodConfig = useLlm ? createDecisionEvalModel() : null;
  const model = methodConfig?.model ?? mockModel(testCase.expected.expectedSelection);
  const method = methodConfig?.method;
  const schemaParams = {
    capabilityCandidates: decisionCandidates.map(({ name }) => ({ name })),
  };
  const system = buildCapabilityDecisionSystemPrompt({
    actor,
    outputInstruction: buildCapabilityDecisionOutputInstruction(schemaParams, method),
  });
  const decisionInput = buildCapabilityDecisionInput({
    pendingTask: {
      task: input.task,
      contextSummary: input.contextSummary ?? null,
    },
    availableExecutorsContext: buildCapabilityDecisionAvailableExecutorsContext({
      capabilityCandidates: decisionCandidates,
    }),
  });
  let selection = decisionCandidates.length === 0
    ? CAPABILITY_UNAVAILABLE_SELECTION
    : '';
  if (!selection) {
    const schema = buildCapabilityDecisionSchema(schemaParams);
    const structured = model.withStructuredOutput(
      schema,
      buildOrchestrationDecisionStructuredOutputOptions({ method }),
    );
    const decision = await structured.invoke([
      new SystemMessage(system),
      new HumanMessage(decisionInput),
    ]);
    selection = schema.parse(decision).selection;
  }
  const candidateNames = candidates.map((candidate) => candidate.name);
  const candidateRecallCorrect = candidateNames.length === testCase.expected.expectedCandidateNames.length
    && candidateNames.every((name) => testCase.expected.expectedCandidateNames.includes(name));
  const scores: LangfuseEvalScore[] = [
    {
      key: 'candidate_recall_correct',
      score: candidateRecallCorrect ? 1 : 0,
      comment: `expected=${testCase.expected.expectedCandidateNames.join(',')}; actual=${candidateNames.join(',')}`,
    },
    ...scoreCapabilityDecision(
      { selection },
      testCase.expected,
    ),
  ];
  return { output: { query, candidateNames, selection }, scores };
}

async function main() {
  const config = resolveLangfuseConfig();
  const useLlm = process.env.EVAL_CAPABILITY_MODEL === 'llm';
  const runName = process.env.LANGFUSE_RUN_NAME
    || `capability-decision-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`Running ${capabilityDecisionBasicsDataset.name}: ${runName}`);
  console.log(`Mode: ${useLlm ? createDecisionEvalModel().label : 'local deterministic capability model'}`);
  let passed = 0;
  for (const testCase of capabilityDecisionBasicsDataset.cases) {
    const started = performance.now();
    try {
      const { output, scores } = await runCase(testCase, useLlm);
      const ok = scores.every((score) => score.score === 1);
      if (ok) passed += 1;
      await writeLangfuseEvalResult({
        config,
        datasetName: capabilityDecisionBasicsDataset.name,
        runName,
        traceName: 'capability-decision-eval',
        testCase,
        output,
        scores,
        durationMs: Math.round(performance.now() - started),
      });
      console.log(`[${ok ? 'PASS' : 'FAIL'}] ${testCase.name}: ${scores.map((score) => `${score.key}=${score.score}`).join(' ')}`);
    } catch (error) {
      console.log(`[ERROR] ${testCase.name}: ${String(error)}`);
    }
  }
  console.log(`Cases: ${passed}/${capabilityDecisionBasicsDataset.cases.length} passed`);
  if (passed !== capabilityDecisionBasicsDataset.cases.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
