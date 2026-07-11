import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AgentModels } from '../../src/types/agent.ts';
import {
  buildCapabilityPlanningDecisionInput,
  buildCapabilityPlanningDecisionSystemPrompt,
} from '../../src/agent/orchestrator/prompts.ts';
import {
  buildCapabilityPlanningDecisionSchema,
  buildCapabilityPlanningDecisionOutputInstruction,
} from '../../src/agent/orchestrator/schemas.ts';
import { derivePlanningMetrics, scoreCapabilityPlanning } from '../decision-contract-scorers.ts';
import { capabilityPlanningBasicsDataset } from '../datasets/capability-planning-basics.ts';
import { createDecisionEvalModel } from './decision-eval-model.ts';
import { resolveLangfuseConfig } from './langfuse-api.ts';
import { writeLangfuseEvalResult } from './langfuse-eval-writer.ts';

const actor = {
  petId: 'eval-pet',
  userId: 'eval-user',
  name: 'planner-eval',
  personality: null,
  stage: null,
  species: null,
};

function deterministicModel(testCase: typeof capabilityPlanningBasicsDataset.cases[number]): AgentModels['act'] {
  const expected = testCase.expected;
  const remainingPlan = expected.planEffect === 'unchanged'
    ? (testCase.input.remainingPlan ?? []).slice(1)
    : expected.remainingPlan.map((item) => ({
      objective: item.objectiveTerms.join(' '),
      capabilityIntent: item.capabilityIntent,
      status: item.status,
    }));
  const unchangedNextTask = expected.planEffect === 'unchanged'
    ? testCase.input.remainingPlan?.[0]
    : null;
  const nextTask = expected.result === 'next_task' ? {
    objective: unchangedNextTask?.objective ?? expected.nextTaskTerms?.join(' ') ?? '',
    capabilityIntent: unchangedNextTask?.capabilityIntent ?? expected.capabilityIntent ?? '',
  } : null;
  return {
    invoke: async () => new AIMessage(''),
    withStructuredOutput: () => ({
      invoke: async () => ({
        result: expected.result,
        remaining_plan: remainingPlan.map((item) => ({
          objective: item.objective,
          capability_intent: item.capabilityIntent,
          status: item.status,
        })),
        next_task: nextTask ? {
          objective: nextTask.objective,
          capability_intent: nextTask.capabilityIntent,
        } : null,
      }),
    }),
  } as unknown as AgentModels['act'];
}

async function runCase(testCase: typeof capabilityPlanningBasicsDataset.cases[number], useLlm: boolean) {
  const modelConfig = useLlm ? createDecisionEvalModel() : null;
  const model = modelConfig?.model ?? deterministicModel(testCase);
  const plannerSchema = buildCapabilityPlanningDecisionSchema();
  const structured = model.withStructuredOutput(plannerSchema, {
    name: 'capability_planning_decision',
    ...(modelConfig?.method ? { method: modelConfig.method } : {}),
  });
  const systemPrompt = buildCapabilityPlanningDecisionSystemPrompt({
    actor,
    outputInstruction: buildCapabilityPlanningDecisionOutputInstruction(),
  });
  const input = buildCapabilityPlanningDecisionInput({
    mode: testCase.input.mode,
    userIntentContext: `<user_intent_context>${testCase.input.userGoal}</user_intent_context>`,
    remainingPlan: testCase.input.remainingPlan ?? [],
    latestHandoff: testCase.input.latestHandoff ?? null,
    capabilityRegistryContext: testCase.input.capabilityRegistry.join('\n'),
  });
  const raw = await structured.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(input),
  ]);
  const parsed = plannerSchema.parse(raw);
  const output = {
    result: parsed.result,
    remainingPlan: parsed.remaining_plan.map((item) => ({
      objective: item.objective,
      capabilityIntent: item.capability_intent,
      status: item.status,
    })),
    nextTask: parsed.next_task?.objective ?? null,
    capabilityIntent: parsed.next_task?.capability_intent ?? null,
  };
  const scores = scoreCapabilityPlanning(output, testCase.expected, testCase.input);
  return {
    output: {
      ...output,
      ...derivePlanningMetrics(
        testCase.input,
        output.remainingPlan,
        output.nextTask && output.capabilityIntent
          ? { objective: output.nextTask, capabilityIntent: output.capabilityIntent }
          : null,
      ),
    },
    scores,
  };
}

async function main() {
  const config = resolveLangfuseConfig();
  const useLlm = process.env.EVAL_PLANNER_MODEL === 'llm';
  const runName = process.env.LANGFUSE_RUN_NAME || `capability-planning-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`Running ${capabilityPlanningBasicsDataset.name}: ${runName}`);
  console.log(`Mode: ${useLlm ? createDecisionEvalModel().label : 'local deterministic contract model'}`);
  let passed = 0;
  let boundaryCount = 0;
  let rubberStampCount = 0;
  for (const testCase of capabilityPlanningBasicsDataset.cases) {
    const started = performance.now();
    try {
      const { output, scores } = await runCase(testCase, useLlm);
      if (testCase.input.mode === 'boundary') {
        boundaryCount += 1;
        if (output.rubberStamp) rubberStampCount += 1;
      }
      const ok = scores.every(({ score }) => score === 1);
      await writeLangfuseEvalResult({ config, datasetName: capabilityPlanningBasicsDataset.name, runName, traceName: `capability-planner-${testCase.input.mode}`, testCase, output, scores, durationMs: Math.round(performance.now() - started) });
      if (ok) passed += 1;
      console.log(`[${ok ? 'PASS' : 'FAIL'}] planner@${testCase.input.mode} ${testCase.name}: ${scores.map(({ key, score }) => `${key}=${score}`).join(' ')}`);
    } catch (error) {
      console.log(`[ERROR] ${testCase.name}: ${String(error)}`);
    }
  }
  console.log(`Cases: ${passed}/${capabilityPlanningBasicsDataset.cases.length} passed`);
  console.log(`Boundary rubber-stamp ratio: ${rubberStampCount}/${boundaryCount}`);
  if (passed !== capabilityPlanningBasicsDataset.cases.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exit(1); });
