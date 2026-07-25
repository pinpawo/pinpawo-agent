import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { searchCapabilities } from '../../src/agent/orchestrator/capabilitySearch.ts';
import {
  buildRouteDecisionInput,
  buildRouteDecisionSystemPrompt,
  buildRouteTargetsContext,
} from '../../src/agent/orchestrator/prompts.ts';
import {
  buildOrchestrationDecisionStructuredOutputOptions,
  buildRouteDecisionOutputInstruction,
  buildRouteDecisionSchema,
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
  return input.availableCapabilities.map((item) => ({
    name: item.name,
    description: `${item.description} Keywords: ${item.keywords.join('|')}`,
    uses: [],
    instructions: defineInstructionDocument({
      content: `Execute the ${item.name} capability.`,
    }),
  }));
}

function mockModel(candidateNames: string[]): AgentModels['act'] {
  const lane = candidateNames[0] ? `capability.${candidateNames[0]}` : 'general';
  return {
    invoke: async () => new AIMessage(''),
    withStructuredOutput: () => ({ invoke: async () => ({ lane }) }),
  } as unknown as AgentModels['act'];
}

function containsTerms(value: string, terms: string[]) {
  return terms.every((term) => value.toLowerCase().includes(term.toLowerCase()));
}

async function runCase(testCase: typeof capabilityDecisionBasicsDataset.cases[number], useLlm: boolean) {
  const input = testCase.input;
  const capabilityList = capabilities(input);
  const candidates = searchCapabilities(input.baselineSearchQuery, capabilityList);
  const methodConfig = useLlm ? createDecisionEvalModel() : null;
  const model = methodConfig?.model ?? mockModel(candidates.map((candidate) => candidate.name));
  const method = methodConfig?.method;
  const schemaParams = { capabilityCandidates: candidates.map(({ name }) => ({ name })) };
  const structured = model.withStructuredOutput(
    buildRouteDecisionSchema(schemaParams),
    buildOrchestrationDecisionStructuredOutputOptions({ method }),
  );
  const system = buildRouteDecisionSystemPrompt({
    actor,
    outputInstruction: buildRouteDecisionOutputInstruction(schemaParams, method),
  });
  const routeInput = buildRouteDecisionInput({
    pendingTask: {
      task: input.task,
      contextSummary: input.contextSummary ?? null,
      searchKeywords: input.baselineSearchQuery,
    },
    targetsContext: buildRouteTargetsContext({
      generalTools: (input.generalToolsAvailable ?? []).map((name) => ({ name, description: `General tool ${name}` })) as never,
      capabilityCandidates: candidates,
      capabilitySearchAttempted: true,
      capabilitySearchQuery: input.baselineSearchQuery,
      capabilityRegistryAvailable: capabilityList.length > 0,
    }),
  });
  const decision = await structured.invoke([new SystemMessage(system), new HumanMessage(routeInput)]);
  const lane = typeof decision === 'object' && decision && 'lane' in decision ? String(decision.lane) : '';
  const candidateNames = candidates.map((candidate) => candidate.name);
  const candidateRecallCorrect = candidateNames.length === testCase.expected.expectedCandidateNames.length
    && candidateNames.every((name) => testCase.expected.expectedCandidateNames.includes(name));
  const scores: LangfuseEvalScore[] = [
    {
      key: 'search_query_correct',
      score: containsTerms(input.baselineSearchQuery, testCase.expected.expectedSearchQueryTerms) ? 1 : 0,
      comment: input.baselineSearchQuery,
    },
    {
      key: 'candidate_recall_correct',
      score: candidateRecallCorrect ? 1 : 0,
      comment: `expected=${testCase.expected.expectedCandidateNames.join(',')}; actual=${candidateNames.join(',')}`,
    },
    ...scoreCapabilityDecision(
      { selectedLane: lane },
      testCase.expected,
    ),
  ];
  return { output: { query: input.baselineSearchQuery, candidateNames, lane }, scores };
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
