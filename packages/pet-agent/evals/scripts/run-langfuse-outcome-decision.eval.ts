import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  buildDelegationOutcomeCurrentTaskContext,
  buildDelegationOutcomeDecisionInput,
  buildDelegationOutcomeDecisionSystemPrompt,
  buildDelegationOutcomeOtherTasksContext,
  buildDelegationOutcomeRemainingPlanContext,
  buildPreparedRequestContext,
  buildSubagentAnnounceContext,
} from '../../src/agent/orchestrator/prompts.ts';
import {
  buildDelegationOutcomeDecisionOutputInstruction,
  buildDelegationOutcomeDecisionSchema,
  buildOrchestrationDecisionStructuredOutputOptions,
} from '../../src/agent/orchestrator/schemas.ts';
import type { AgentModels } from '../../src/types/agent.ts';
import { scoreOutcomeDecision } from '../decision-contract-scorers.ts';
import { outcomeDecisionBasicsDataset } from '../datasets/outcome-decision-basics.ts';
import { createDecisionEvalModel } from './decision-eval-model.ts';
import { resolveLangfuseConfig } from './langfuse-api.ts';
import { writeLangfuseEvalResult } from './langfuse-eval-writer.ts';
import { createLangfuseV4Runtime } from './langfuse-v4-runtime.ts';

const actor = { petId: 'eval-pet', userId: 'eval-user', name: 'outcome-eval', personality: null, stage: null, species: null };

function deterministicModel(outcome: string): AgentModels['act'] {
  return {
    invoke: async () => new AIMessage(''),
    withStructuredOutput: () => ({ invoke: async () => ({ outcome, gap_note: outcome === 'goal_done' ? null : 'baseline' }) }),
  } as unknown as AgentModels['act'];
}

async function runCase(
  testCase: typeof outcomeDecisionBasicsDataset.cases[number],
  modelConfig: ReturnType<typeof createDecisionEvalModel> | null,
) {
  const model = modelConfig?.model ?? deterministicModel(testCase.expected.outcome);
  const structured = model.withStructuredOutput(
    buildDelegationOutcomeDecisionSchema(),
    buildOrchestrationDecisionStructuredOutputOptions({ method: modelConfig?.method }),
  );
  const systemPrompt = buildDelegationOutcomeDecisionSystemPrompt({
    actor,
    outputInstruction: buildDelegationOutcomeDecisionOutputInstruction(modelConfig?.method),
  });
  const delegationId = 'eval-delegation';
  const input = buildDelegationOutcomeDecisionInput({
    userIntentContext: buildPreparedRequestContext({
      latestUserRequest: testCase.input.userGoal,
      recentMessages: [new HumanMessage(testCase.input.userGoal)],
    }),
    currentTaskContext: buildDelegationOutcomeCurrentTaskContext({
      id: delegationId,
      lane: 'capability:general',
      task: testCase.input.currentTask,
      contextSummary: null,
    }),
    subagentAnnounceContext: buildSubagentAnnounceContext({
      lane: 'capability:general',
      delegationId,
      task: testCase.input.currentTask,
      text: testCase.input.announce,
    }, 'natural'),
    otherTasksContext: buildDelegationOutcomeOtherTasksContext(
      (testCase.input.completedHandoffs ?? []).map((resultPreview, index) => ({
        id: `completed-${index}`,
        lane: 'capability:general',
        task: `Completed task ${index + 1}`,
        status: 'completed',
        resultPreview,
      })),
      delegationId,
    ),
    remainingPlanContext: buildDelegationOutcomeRemainingPlanContext(
      testCase.input.remainingPlan ?? [],
    ),
  });
  const output = await structured.invoke(
    [new SystemMessage(systemPrompt), new HumanMessage(input)],
    modelConfig
      ? {
          metadata: {
            promptEvalModelRole: 'subject',
            modelProfileId: modelConfig.metadata.profileId,
            modelProfileFingerprint: modelConfig.metadata.fingerprint,
          },
        }
      : undefined,
  ) as Record<string, unknown>;
  return { output, scores: scoreOutcomeDecision(output, testCase.expected) };
}

async function main() {
  const config = resolveLangfuseConfig();
  const runtime = createLangfuseV4Runtime(config);
  const useLlm = process.env.EVAL_OUTCOME_MODEL !== 'deterministic';
  const profileId = process.env.PROMPT_EVAL_MODEL_PROFILE_ID?.trim();
  if (useLlm && !profileId) {
    throw new Error('PROMPT_EVAL_MODEL_PROFILE_ID is required for real-model mode.');
  }
  const modelConfig = useLlm
    ? createDecisionEvalModel({
        profileId: profileId!,
        role: 'subject',
      })
    : null;
  const runName = process.env.LANGFUSE_RUN_NAME || `outcome-decision-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`Running ${outcomeDecisionBasicsDataset.name}: ${runName}`);
  console.log(`Mode: ${modelConfig?.label ?? 'local deterministic contract model'}`);
  let passed = 0;
  for (const testCase of outcomeDecisionBasicsDataset.cases) {
    const started = performance.now();
    try {
      const { output, scores } = await runCase(testCase, modelConfig);
      const ok = scores.every(({ score }) => score === 1);
      if (ok) passed += 1;
      await writeLangfuseEvalResult({
        runtime,
        datasetName: outcomeDecisionBasicsDataset.name,
        runName,
        traceName: 'outcome-decision-eval',
        testCase,
        output,
        scores,
        durationMs: Math.round(performance.now() - started),
        ...(modelConfig
          ? {
              metadata: {
                subjectModelProfileId: modelConfig.metadata.profileId,
                subjectModelProfileFingerprint: modelConfig.metadata.fingerprint,
              },
            }
          : {}),
      });
      console.log(`[${ok ? 'PASS' : 'FAIL'}] ${testCase.name}: ${scores.map(({ key, score }) => `${key}=${score}`).join(' ')}`);
    } catch (error) {
      console.log(`[ERROR] ${testCase.name}: ${String(error)}`);
    }
  }
  await runtime.shutdown();
  console.log(`Cases: ${passed}/${outcomeDecisionBasicsDataset.cases.length} passed`);
  if (passed !== outcomeDecisionBasicsDataset.cases.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exit(1); });
