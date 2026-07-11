import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { AgentModels } from '../../src/types/agent.ts';
import { derivePlanningMetrics, scoreCapabilityPlanning } from '../decision-contract-scorers.ts';
import { capabilityPlanningBasicsDataset } from '../datasets/capability-planning-basics.ts';
import { createDecisionEvalModel } from './decision-eval-model.ts';
import { resolveLangfuseConfig } from './langfuse-api.ts';
import { writeLangfuseEvalResult } from './langfuse-eval-writer.ts';

const plannerSchema = z.object({
  result: z.enum(['next_task', 'answer']),
  remaining_plan: z.array(z.object({
    objective: z.string(),
    capability_intent: z.string(),
    status: z.enum(['concrete', 'deferred']),
  })),
  next_task: z.object({ objective: z.string(), capability_intent: z.string() }).nullable(),
});

const systemPrompt = [
  'You are the eval-only capability planner for pet-agent. This prompt is not used by the production graph.',
  'Plan capability subagent execution boundaries, not textual steps or tool calls.',
  'A task is one isolated capability execution. Different tasks share conclusions only through announce/handoff.',
  'Use capability_intent to describe the needed ability. Never bind a concrete registered capability id.',
  'In entry mode, create only meaningful execution boundaries and return the first concrete task.',
  'In boundary mode, use the latest handoff to revise, materialize, keep, or cancel remaining work before returning the next task.',
  'remaining_plan contains all not-yet-completed tasks, including the concrete next_task as its first item.',
  'Do not invent implementation details that depend on a future exploration handoff.',
  'If no work remains, result=answer and next_task=null.',
].join('\n');

function deterministicModel(testCase: typeof capabilityPlanningBasicsDataset.cases[number]): AgentModels['act'] {
  const expected = testCase.expected;
  const remainingPlan = expected.planEffect === 'unchanged'
    ? testCase.input.remainingPlan ?? []
    : expected.remainingPlan.map((item) => ({
      objective: item.objectiveTerms.join(' '),
      capabilityIntent: item.capabilityIntent,
      status: item.status,
    }));
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
        next_task: expected.result === 'next_task' ? {
          objective: expected.nextTaskTerms?.join(' ') ?? '',
          capability_intent: expected.capabilityIntent ?? 'general',
        } : null,
      }),
    }),
  } as unknown as AgentModels['act'];
}

async function runCase(testCase: typeof capabilityPlanningBasicsDataset.cases[number], useLlm: boolean) {
  const modelConfig = useLlm ? createDecisionEvalModel() : null;
  const model = modelConfig?.model ?? deterministicModel(testCase);
  const structured = model.withStructuredOutput(plannerSchema, {
    name: 'capability_planning_decision',
    ...(modelConfig?.method ? { method: modelConfig.method } : {}),
  });
  const raw = await structured.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(JSON.stringify(testCase.input, null, 2)),
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
  return { output: { ...output, ...derivePlanningMetrics(testCase.input, output.remainingPlan) }, scores };
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
      if (ok) passed += 1;
      await writeLangfuseEvalResult({ config, datasetName: capabilityPlanningBasicsDataset.name, runName, traceName: `capability-planner-${testCase.input.mode}`, testCase, output, scores, durationMs: Math.round(performance.now() - started) });
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
