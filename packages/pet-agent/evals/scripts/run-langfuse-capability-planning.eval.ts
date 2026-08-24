import { tool } from '@langchain/core/tools';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createCapabilityPlannerAgent } from '../../src/agent/orchestrator/capabilityPlanner/agent.ts';
import { CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME } from '../../src/agent/orchestrator/capabilityPlanner/fileExplorer.ts';
import {
  isCapabilityPlannerIncompleteResult,
  type CapabilityPlannerInput,
  type CapabilityPlannerResult,
} from '../../src/agent/orchestrator/capabilityPlanner/runner.ts';
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
  buildCapabilityPlanningMessages,
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
  if (isCapabilityPlannerIncompleteResult(result)) {
    return {
      result: 'planner_incomplete',
      nextTask: null,
      capabilityName: null,
      remainingPlan: [],
    };
  }
  if (result.action !== 'execute_plan'
    && result.action !== 'advance_plan'
    && result.action !== 'continue_current') {
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

function plannerDiagnostics(result: CapabilityPlannerResult) {
  const searchCallIds = new Set(
    result.messageUpdates?.flatMap((message) =>
      ToolMessage.isInstance(message)
      && message.name === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME
      ? [message.tool_call_id]
      : []) ?? [],
  );
  const searchRounds = result.messageUpdates?.filter((message) =>
    AIMessage.isInstance(message)
    && message.tool_calls?.some((toolCall) =>
      toolCall.name === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME))
    .length ?? 0;
  const searchQueries = result.messageUpdates?.flatMap((message) =>
    AIMessage.isInstance(message)
      ? message.tool_calls?.flatMap((toolCall) =>
          toolCall.name === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME
            ? [{
                toolCallId: toolCall.id ?? null,
                terms: toolCall.args && typeof toolCall.args === 'object'
                  && 'terms' in toolCall.args && Array.isArray(toolCall.args.terms)
                  ? toolCall.args.terms.filter((term): term is string => typeof term === 'string')
                  : [],
              }]
            : []) ?? []
      : []) ?? [];
  const searchResults = result.messageUpdates?.flatMap((message) => {
    if (!ToolMessage.isInstance(message)
      || message.name !== CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME
      || typeof message.content !== 'string') {
      return [];
    }
    try {
      const payload = JSON.parse(message.content) as {
        data?: { matches?: Array<{ path?: unknown }> };
        exploration?: {
          specificCandidates?: unknown;
          defaultCandidate?: unknown;
          status?: unknown;
          remainingRounds?: unknown;
        };
      };
      return [{
        toolCallId: message.tool_call_id,
        matchedPaths: Array.isArray(payload.data?.matches)
          ? payload.data.matches.flatMap(({ path }) => typeof path === 'string' ? [path] : [])
          : [],
        specificCandidates: Array.isArray(payload.exploration?.specificCandidates)
          ? payload.exploration.specificCandidates.filter(
              (candidate): candidate is string => typeof candidate === 'string',
            )
          : [],
        defaultCandidate: typeof payload.exploration?.defaultCandidate === 'string'
          ? payload.exploration.defaultCandidate
          : null,
        status: typeof payload.exploration?.status === 'string'
          ? payload.exploration.status
          : null,
        remainingRounds: typeof payload.exploration?.remainingRounds === 'number'
          ? payload.exploration.remainingRounds
          : null,
      }];
    } catch {
      return [{
        toolCallId: message.tool_call_id,
        matchedPaths: [],
        specificCandidates: [],
        defaultCandidate: null,
        status: null,
        remainingRounds: null,
      }];
    }
  }) ?? [];
  return {
    searchCalls: searchCallIds.size,
    searchRounds,
    searchQueries,
    searchResults,
    plannerStatus: isCapabilityPlannerIncompleteResult(result)
      ? result.plannerStatus
      : 'committed',
  } as const;
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
        const plannerInputBase = {
          inputId: `${testCase.input.mode}:${testCase.id}`,
          traceId: `eval:${testCase.id}`,
          runId: `eval:${testCase.id}`,
          userRequest: testCase.input.userRequest,
          messages: [
            ...buildCapabilityPlanningMessages(testCase.input.messages),
            ...(testCase.input.mode === 'boundary' && testCase.input.latestAnnounce
              ? [new AIMessage({
                  id: 'eval-announce',
                  content: testCase.input.latestAnnounce,
                })]
              : []),
          ],
          remainingPlan: testCase.input.remainingPlan ?? [],
          workspace,
        };
        const plannerInput: CapabilityPlannerInput = testCase.input.mode === 'boundary'
          ? {
              ...plannerInputBase,
              mode: 'boundary',
              activeDelegation: {
                delegationId: 'eval-delegation',
                transcriptRunId: `eval:${testCase.id}`,
                capability: testCase.input.activeCapability
                  ?? testCase.input.remainingPlan?.[0]?.capability
                  ?? workspace.capabilityNames[0]
                  ?? 'unavailable',
                task: testCase.input.activeTask ?? 'Evaluate the current task.',
              },
              latestAnnounce: {
                messageId: 'eval-announce',
                completionReason: 'natural',
              },
            }
          : {
              ...plannerInputBase,
              mode: 'entry',
              activeDelegation: null,
              latestAnnounce: null,
            };
        const result = await createCapabilityPlannerAgent({
          model: modelConfig.model,
        }).invoke(
          plannerInput,
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
        const diagnostics = plannerDiagnostics(result);
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
              ...diagnostics,
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
          + `search_calls=${diagnostics.searchCalls.toString()} `
          + `search_rounds=${diagnostics.searchRounds.toString()} `
          + `planner_status=${diagnostics.plannerStatus} `
          + evaluation.scores.map(({ key, score }) => `${key}=${score}`).join(' '),
        );
        if (!ok && showFailureDetails) {
          console.log(JSON.stringify({
            output,
            diagnostics,
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
