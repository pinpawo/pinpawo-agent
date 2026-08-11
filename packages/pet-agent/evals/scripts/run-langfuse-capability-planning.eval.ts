import { tool } from '@langchain/core/tools';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createCapabilityPlannerAgent } from '../../src/agent/orchestrator/capabilityPlanner/agent.ts';
import type { CapabilityPlannerResult } from '../../src/agent/orchestrator/capabilityPlanner/runner.ts';
import { materializeCapabilityDocumentWorkspace } from '../../src/agent/orchestrator/capabilityPlanner/documentWorkspace.ts';
import { compileAgentRegistry } from '../../src/agent/orchestrator/registry.ts';
import {
  defineCapability,
  defineInstructionDocument,
  type AgentCapability,
} from '../../src/types/capability.ts';
import { defineToolkit } from '../../src/types/toolkit.ts';
import {
  evaluateCapabilityPlanningOutput,
  type CapabilityPlanningEvalOutput,
} from '../capability-planning-evaluation.ts';
import {
  capabilityPlanningBasicsDataset,
  type CapabilityPlanningInput,
} from '../datasets/capability-planning-basics.ts';
import { createDecisionEvalModel } from './decision-eval-model.ts';
import { resolveLangfuseConfig } from './langfuse-api.ts';
import { writeLangfuseEvalResult } from './langfuse-eval-writer.ts';
import { createLangfuseV4Runtime } from './langfuse-v4-runtime.ts';

const evalExecutionToolkit = defineToolkit({
  name: 'eval_execution',
  description: 'Synthetic execution adapter for Capability Planner semantic evaluation.',
  tools: [{
    tool: tool(async () => 'ok', {
      name: 'eval_execute',
      description: 'Execute the task described by the selected eval Capability.',
      schema: z.object({}),
    }),
  }],
});

function capabilityFromRegistryEntry(entry: string): AgentCapability {
  const separator = entry.indexOf(':');
  const name = (separator >= 0 ? entry.slice(0, separator) : entry).trim();
  const description = (separator >= 0 ? entry.slice(separator + 1) : entry).trim();
  return defineCapability({
    name,
    description: description || `Execute work assigned to ${name}.`,
    uses: [evalExecutionToolkit.name],
    instructions: defineInstructionDocument({
      content: [
        `# ${name}`,
        '',
        description || `Complete the task assigned to ${name}.`,
        '',
        'Complete the delegated task and return a concise evidence-based result.',
      ].join('\n'),
    }),
  });
}

function plannerOutput(
  result: CapabilityPlannerResult,
): CapabilityPlanningEvalOutput {
  if (result.action !== 'execute_plan' && result.action !== 'continue_current') {
    return {
      result: result.action,
      nextTask: null,
      capabilityName: null,
      remainingPlan: [],
    };
  }
  const [nextTask, ...remainingPlan] = result.tasks;
  return {
    result: result.action,
    nextTask: nextTask?.task ?? null,
    capabilityName: nextTask?.capability ?? null,
    remainingPlan: remainingPlan.map((task) => ({ ...task })),
  };
}

function splitList(value: string | undefined): string[] {
  return value?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
}

function selectedCases() {
  const requested = new Set(splitList(process.env.EVAL_CASES));
  if (requested.size === 0) return capabilityPlanningBasicsDataset.cases;
  return capabilityPlanningBasicsDataset.cases.filter((testCase) =>
    requested.has(testCase.id) || requested.has(testCase.name),
  );
}

async function main() {
  const writeLangfuseResults = process.env.CAPABILITY_PLANNING_EVAL_WRITE_LANGFUSE
    !== '0';
  const showFailureDetails = process.env.CAPABILITY_PLANNING_EVAL_SHOW_FAILURE_DETAILS
    === '1';
  const config = writeLangfuseResults ? resolveLangfuseConfig() : null;
  const runtime = config ? createLangfuseV4Runtime(config) : null;
  const cases = selectedCases();
  if (cases.length === 0) {
    throw new Error(`No eval cases selected. EVAL_CASES=${process.env.EVAL_CASES ?? '(unset)'}`);
  }
  const subjectProfileId = process.env.PROMPT_EVAL_MODEL_PROFILE_ID?.trim();
  const judgeProfileId = process.env.PROMPT_EVAL_JUDGE_PROFILE_ID?.trim();
  if (!subjectProfileId || !judgeProfileId) {
    throw new Error(
      'PROMPT_EVAL_MODEL_PROFILE_ID and PROMPT_EVAL_JUDGE_PROFILE_ID are required.',
    );
  }
  const modelConfig = createDecisionEvalModel({
    profileId: subjectProfileId,
    role: 'subject',
  });
  const judgeConfig = createDecisionEvalModel({
    profileId: judgeProfileId,
    role: 'judge',
  });
  if (modelConfig.metadata.fingerprint === judgeConfig.metadata.fingerprint) {
    throw new Error('Capability planning subject and judge fingerprints must differ.');
  }
  const runName = process.env.LANGFUSE_RUN_NAME
    || `capability-planning-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const cacheRoot = await mkdtemp(join(tmpdir(), 'pinpawo-capability-planning-eval-'));
  let passed = 0;

  console.log(`Running ${capabilityPlanningBasicsDataset.name}: ${runName}`);
  console.log(`Mode: ${modelConfig.label}`);
  console.log(`Judge: ${judgeConfig.label}`);
  console.log(`Result sink: ${config ? 'Langfuse' : 'stdout only'}`);
  try {
    for (const testCase of cases) {
      const started = performance.now();
      try {
        const registry = compileAgentRegistry({
          toolkits: [evalExecutionToolkit],
          capabilities: testCase.input.capabilityRegistry.map(capabilityFromRegistryEntry),
        });
        const workspace = await materializeCapabilityDocumentWorkspace({
          registry,
          cacheRoot,
        });
        const result = await createCapabilityPlannerAgent({
          model: modelConfig.model,
        }).invoke(
          {
            mode: testCase.input.mode,
            inputId: `${testCase.input.mode}:${testCase.id}`,
            traceId: `eval:${testCase.id}`,
            runId: `eval:${testCase.id}`,
            userGoal: testCase.input.userGoal,
            latestUserMessage: null,
            activeDelegation: testCase.input.mode === 'boundary'
              ? {
                  delegationId: 'eval-delegation',
                  capability: testCase.input.remainingPlan?.[0]?.capability
                    ?? workspace.capabilityNames[0]
                    ?? 'unavailable',
                  task: testCase.input.activeTask ?? 'Evaluate the current task.',
                }
              : null,
            latestAnnounce: testCase.input.mode === 'boundary'
              ? {
                  messageId: 'eval-announce',
                  text: testCase.input.latestAnnounce ?? null,
                  completionReason: 'natural',
                }
              : null,
            remainingPlan: testCase.input.remainingPlan ?? [],
            workspace,
          },
          {
            configurable: {
              thread_id: `capability-planning-eval:${testCase.id}`,
            },
            metadata: {
              promptEvalModelRole: 'subject',
              modelProfileId: modelConfig.metadata.profileId,
              modelProfileFingerprint: modelConfig.metadata.fingerprint,
            },
          },
        );
        const output = plannerOutput(result);
        const evaluation = await evaluateCapabilityPlanningOutput({
          input: testCase.input,
          expected: testCase.expected,
          output,
          judge: {
            model: judgeConfig.model,
            method: judgeConfig.method,
            config: {
              metadata: {
                promptEvalModelRole: 'judge',
                modelProfileId: judgeConfig.metadata.profileId,
                modelProfileFingerprint: judgeConfig.metadata.fingerprint,
              },
            },
          },
        });
        const ok = evaluation.scores.every(({ score }) => score === 1);
        if (ok) passed += 1;
        if (runtime) {
          await writeLangfuseEvalResult({
            runtime,
            datasetName: capabilityPlanningBasicsDataset.name,
            runName,
            traceName: 'capability-planning-eval',
            testCase,
            output: {
              ...output,
              evaluationSummary: evaluation.evaluationSummary,
            },
            scores: evaluation.scores,
            durationMs: Math.round(performance.now() - started),
            metadata: {
              subjectModelProfileId: modelConfig.metadata.profileId,
              subjectModelProfileFingerprint: modelConfig.metadata.fingerprint,
              judgeModelProfileId: judgeConfig.metadata.profileId,
              judgeModelProfileFingerprint: judgeConfig.metadata.fingerprint,
            },
          });
        }
        console.log(
          `[${ok ? 'PASS' : 'FAIL'}] ${testCase.name}: `
          + evaluation.scores.map(({ key, score }) => `${key}=${score}`).join(' '),
        );
        if (!ok && showFailureDetails) {
          console.log(JSON.stringify({
            output,
            evaluationSummary: evaluation.evaluationSummary,
          }, null, 2));
        }
      } catch (error) {
        if (runtime) {
          await writeLangfuseEvalResult({
            runtime,
            datasetName: capabilityPlanningBasicsDataset.name,
            runName,
            traceName: 'capability-planning-eval',
            testCase,
            output: {},
            scores: [],
            durationMs: Math.round(performance.now() - started),
            error: error instanceof Error ? error.message : String(error),
            metadata: {
              subjectModelProfileId: modelConfig.metadata.profileId,
              subjectModelProfileFingerprint: modelConfig.metadata.fingerprint,
              judgeModelProfileId: judgeConfig.metadata.profileId,
              judgeModelProfileFingerprint: judgeConfig.metadata.fingerprint,
            },
          });
        }
        console.log(`[ERROR] ${testCase.name}: ${String(error)}`);
      }
    }
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
    await runtime?.shutdown();
  }
  console.log(`Cases: ${passed}/${cases.length} passed`);
  if (passed !== cases.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
