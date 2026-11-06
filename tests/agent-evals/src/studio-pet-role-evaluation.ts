import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { mergeConfigs } from '@langchain/core/runnables';
import { z } from 'zod';
import { loadCapabilityDirectory } from '../../../services/host/src/capabilityLoader.ts';
import { loadPetDocumentFile } from '../../../services/host/src/config/petDocument.ts';
import type { AgentModels } from '../../../packages/pet-agent/src/types/agent.ts';
import type { AgentToolkit } from '../../../packages/pet-agent/src/types/toolkit.ts';
import { buildAgentRunnableConfig } from '../../../packages/pet-agent/src/agent/runAgent.ts';
import { buildOrchestratorRunInput } from '../../../packages/pet-agent/src/agent/orchestrator/state.ts';
import { createOrchestratorGraph } from '../../../packages/pet-agent/src/agent/orchestrator/runtime/graph.ts';
import { createCapabilityCatalog } from '../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/capabilityCatalog.ts';
import { createCapabilityDisclosureState } from '../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/capabilityDisclosure.ts';
import { currentSupervisorTask } from '../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/state.ts';
import { identity } from '../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/controlContext.ts';
import { buildCapabilityExecutionInput } from '../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/delegateCapabilityTool.ts';
import { isSupervisorControlTool } from '../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/protocol.ts';
import { createRunSupervisorProbe, parseSupervisorControl, scriptedSupervisorResult, supervisorReply } from '../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/testing.ts';
import type { RunSupervisorInput, RunSupervisorResult } from '../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/runner.ts';
import { createCapabilityExecutionMessage, readCapabilityExecutions } from '../../../packages/pet-agent/src/agent/orchestrator/executionMessages.ts';
import { setAgentMessageMetadata } from '../../../packages/pet-agent/src/agent/messages';
import { evaluatePromptGoal, PromptEvalJudgeError, type PromptEvalJudge } from './prompt-goal-evaluator.ts';
import type { DecisionContractScore } from './decision-contract-scorers.ts';
import type { StudioPetRole, StudioPetRoleCase } from './datasets/studio-pet-roles.ts';
import { assembleStudioPetInvocation } from './studio-pet-invocation-fixture.ts';
import { buildStudioPetChannelRequest } from './studio-pet-channel-input.ts';
import { createStudioPetModelObserver } from './studio-pet-model-observer.ts';
import { runStudioPetFlow } from './studio-pet-flow.ts';

export const defaultStudioPetTemplateRoot = fileURLToPath(new URL('../../../packages/studio/templates/default/', import.meta.url));

// A synthetic team's common announcement. Expectations and per-case scoring
// criteria never enter the subject's prompt.
export const studioPetEvalAnnouncement = `这是示例笔记项目的协作 Channel。
Issuer（pet:issuer）负责 Issue 整理、状态跟进和与人类对齐进展。
Executor（pet:executor）负责已有授权范围内的实现、修复和自测，提供可审查产物。
Reviewer（pet:reviewer）负责对照人类意图独立审查改动和证据，给出结论与具体问题。
Wiki（pet:wiki）负责依据交付和来源维护项目知识，区分事实、草稿和未知状态。
Human（human:owner）是本项目的人类参与者。
超出自己职责的工作说明所需帮助，不自行接管。参考当前 Channel 与 GitHub 证据，复用已有结论；新的事实可改变旧结论。涉及未决定的产品取舍时向人类说明，不替人类作决定。`;

const templateConfigSchema = z.object({
  defaultCapabilityName: z.string().min(1),
  sharedCapabilities: z.array(z.string().min(1)).default([]),
}).passthrough();

// Supervisor sees Toolkit metadata, not executable domain tools. Neutral
// descriptors retain the available domains without giving the subject a fake
// GitHub/filesystem implementation or claiming that a tool was exercised.
const toolkitDescriptions: Record<string, string> = {
  files: 'Read and edit local files.', shell: 'Run shell commands.',
  web: 'Read web sources.', git: 'Inspect and modify Git working trees.',
  github: 'Read and manage GitHub issues, pull requests and review evidence.',
  channel: 'Read Channel context, members and messages.',
  project_files: 'Read and write the Channel project knowledge files.',
};

export async function loadStudioPetRoleContext(role: StudioPetRole, templateRoot = defaultStudioPetTemplateRoot,
  channelAnnouncement = studioPetEvalAnnouncement, request?: string) {
  const config = templateConfigSchema.parse(JSON.parse(await readFile(join(templateRoot, 'pets', `${role}.json`), 'utf8')));
  const [pet, owned, shared] = await Promise.all([
    loadPetDocumentFile(join(templateRoot, 'pets', role, 'PET.md')),
    loadCapabilityDirectory(join(templateRoot, 'pets', role, 'capabilities')),
    loadCapabilityDirectory(join(templateRoot, 'capabilities')),
  ]);
  if (!pet) throw new Error(`Missing PET.md for ${role}.`);
  const referenced = config.sharedCapabilities.map(name => {
    const match = shared.find(item => item.capability.name === name);
    if (!match) throw new Error(`Unknown shared Capability ${name} for ${role}.`);
    return match;
  });
  const capabilities = [...owned, ...referenced].map(item => item.capability);
  const toolkits: AgentToolkit[] = [...new Set(capabilities.flatMap(capability => capability.uses))].map(name => {
    if (!toolkitDescriptions[name]) throw new Error(`Add an explicit eval Toolkit descriptor for ${name}.`);
    return { name, description: toolkitDescriptions[name], instructions: toolkitDescriptions[name], tools: [] };
  });
  const setup = await assembleStudioPetInvocation({ role, pet, capabilities, toolkits,
    defaultCapabilityName: config.defaultCapabilityName, announcement: channelAnnouncement, request });
  const registry = setup.registry;
  if (registry.unavailableCapabilities.length || !registry.capabilities.some(item => item.capability.name === config.defaultCapabilityName)) {
    throw new Error(`Incomplete Capability assembly for ${role}.`);
  }
  const catalog = createCapabilityCatalog({ registry });
  const runtimeContext = setup.input.context!;
  const systemPromptSections = runtimeContext.systemPromptSections!;
  return { config, registry, catalog, runtimeContext, systemPromptSections, messages: setup.input.messages };
}

function conversation(testCase: StudioPetRoleCase) {
  return [new HumanMessage(buildStudioPetChannelRequest(testCase))];
}

export function buildStudioPetBoundaryInput(testCase: StudioPetRoleCase, catalog: RunSupervisorInput['catalog'],
  messages: BaseMessage[] = conversation(testCase)): RunSupervisorInput {
  const boundary = testCase.boundary;
  if (testCase.phase !== 'boundary' || !boundary) throw new Error('Boundary case requires a returned Capability fixture.');
  if (!catalog.capabilityNames.includes(boundary.capability)) throw new Error('Fixture Capability is not configured for this Pet.');
  // IDs carry identity, not case labels or temporal hints such as "previous".
  // Reuse production plan/delegation identities with repeatable opaque seeds.
  const opaque = (kind: string) => createHash('sha256').update(JSON.stringify([testCase.id, kind])).digest('hex').slice(0, 32);
  const runId = opaque('run').slice(0, 8);
  const metadata = { runId, taskId: opaque('root-task') };
  const callId = `call_${opaque('delegation-call')}`;
  const planCallId = `call_${opaque('plan-call')}`;
  // Valid native call/result pair; this delivery is supplied evidence, never a
  // claim that this harness executed the described tools or changed a project.
  const briefing = boundary.task;
  const state: RunSupervisorInput['state'] = { runId, goal: boundary.goal, plan: [
    { objective: boundary.task, capability: boundary.capability }, ...(boundary.remaining ?? []),
  ].map((task, index) => ({ ...task, id: identity('task', runId, planCallId, String(index)), status: 'pending' })) };
  const execution = buildCapabilityExecutionInput({ state, runId, allowedCapabilityNames: catalog.capabilityNames }, { briefing }, callId);
  const delegationId = execution.delegationId;
  return {
    mode: 'boundary', inputId: opaque('boundary'), ...metadata, userRequest: boundary.goal,
    catalog,
    capabilityDisclosure: createCapabilityDisclosureState({ catalog, seedCapabilityNames: boundary.disclosedCapabilities ?? [] }),
    state,
    messages: [...messages,
      setAgentMessageMetadata(new AIMessage({ content: '', tool_calls: [{
        id: callId, type: 'tool_call', name: 'delegate_capability', args: { briefing },
      }] }), { ...metadata, source: 'supervisor' }),
      createCapabilityExecutionMessage({ callId, metadata,
        execution,
        result: { status: 'returned', delivery: {
          id: `delivery:${runId}:${delegationId}:${opaque('delivery')}`, task: boundary.task, text: boundary.delivery,
          scope: { ...metadata, lane: `capability:${boundary.capability}`, delegationId },
        } },
      }),
    ],
  };
}

function projectMessages(messages: readonly BaseMessage[]) {
  return messages.map(message => ({ type: message._getType(), text: message.text,
    ...(AIMessage.isInstance(message) ? { calls: message.tool_calls ?? [] } : {}),
    ...(ToolMessage.isInstance(message) ? { name: message.name ?? null, status: message.status ?? null } : {}),
  }));
}

export class StudioPetRoleJudgeError extends PromptEvalJudgeError {
  constructor(cause: unknown, readonly partial: {
    output: Record<string, unknown>;
    scores: DecisionContractScore[];
    contextHash: string;
    evaluationSummary: null;
  }) { super(cause); }
}

export class StudioPetRoleInvocationError extends Error {
  constructor(cause: unknown, readonly partial: StudioPetRoleJudgeError['partial']) {
    super('Studio role model invocation failed; inspect the recorded model calls.', { cause });
    this.name = 'StudioPetRoleInvocationError';
  }
}

/** Separate model-authored claims from runtime-delivered scenario evidence. */
export function buildStudioPetRoleJudgmentInput(testCase: StudioPetRoleCase,
  context: Awaited<ReturnType<typeof loadStudioPetRoleContext>>, output: Record<string, unknown>) {
  const { modelCalls: _diagnostics, scope: _harnessScope, executions, ...candidateOutput } = output;
  const assessmentByPhase = {
    entry: {
      target: 'goal-plan-briefing-or-direct-reply',
      execution: 'stopped-before-first-capability-execution',
      interpretation: 'This probe intentionally stops at the first accepted delegation or a direct reply. Judge the proposed goal, plan, briefing, or direct reply against each criterion. Do not require completed implementation, investigation, review, or Wiki artifacts from an unexecuted delegation. A sound proposal can satisfy a planning criterion; an unsupported claim that work already completed must still fail the relevant grounding criterion.',
    },
    boundary: {
      target: 'decision-after-supplied-delivery',
      execution: 'prior-delivery-supplied-next-delegation-not-executed',
      interpretation: 'Judge the next decision after the supplied prior delivery: a justified follow-up delegation, an appropriate final reply, or a human question. The probe stops before executing any newly delegated work. Judge existing completion claims against the supplied delivery; do not require future delegated work to have completed.',
    },
    flow: {
      target: 'continuous-decisions-and-final-reply',
      execution: 'controlled-capability-deliveries-returned-during-run',
      interpretation: 'Judge the actual goal, plan, delegations, decisions after returned deliveries, and final reply across the continuous run. A plan or briefing alone does not satisfy a criterion requiring an execution result. Use only returned deliveries as evidence of delegated work, not unexecuted proposals.',
    },
  } as const;
  return {
    contract: 'studio.pet_role.goal_plan_briefing', objective: testCase.request,
    acceptanceCriteria: testCase.expected.criteria,
    evidence: {
      evaluationBoundary: { phase: testCase.phase, ...assessmentByPhase[testCase.phase] },
      scenario: {
        kind: 'controlled-simulation',
        interpretation: 'Returned Capability deliveries are observations available to the subject inside this scenario. Assess its decisions and claims against those returned contents, including their uncertainty and scope. Do not reject a supported claim merely because the evaluation backend is simulated, and do not require the subject to disclose backend simulation it was not told about. A briefing request alone is not evidence that the requested action completed.',
      },
      request: testCase.request, currentChannelInput: buildStudioPetChannelRequest(testCase),
      channelMessages: testCase.channelMessages, boundary: testCase.boundary ?? null,
      returnedExecutions: executions ?? [], runtimeContext: context.runtimeContext,
      capabilities: context.catalog.entries,
    },
    candidateOutput,
  };
}

export async function runStudioPetRoleCase(params: {
  testCase: StudioPetRoleCase;
  model: AgentModels['act'];
  judge: PromptEvalJudge;
  config?: RunnableConfig;
  templateRoot?: string;
  /** Optional private Channel announcement; never needs to be checked into the dataset. */
  channelAnnouncement?: string;
  /** Retain full final inputs only for explicitly synthetic diagnostic runs. */
  captureSyntheticContent?: boolean;
}): Promise<{ output: Record<string, unknown>; scores: DecisionContractScore[]; contextHash: string; evaluationSummary: string | null }> {
  const { testCase } = params;
  const request = buildStudioPetChannelRequest(testCase);
  const context = await loadStudioPetRoleContext(testCase.role, params.templateRoot, params.channelAnnouncement, request);
  const runtimeContext = context.runtimeContext;
  const observer = createStudioPetModelObserver({ petRole: testCase.role,
    captureSyntheticContent: params.captureSyntheticContent,
    sources: [...context.systemPromptSections,
      ...context.catalog.entries.map(entry => ({ id: `capability-document:${entry.capabilityName}`, content: entry.content })),
      ...context.registry.capabilities.map(item => ({ id: `capability-body:${item.capability.name}`, content: item.capability.instructions.content })),
    ],
  });
  const config: RunnableConfig = mergeConfigs(params.config, { callbacks: [observer.callback] });
  const evidence = { request: testCase.request, currentChannelInput: request,
    channelMessages: testCase.channelMessages, boundary: testCase.boundary ?? null,
    runtimeContext, capabilities: context.catalog.entries };
  const contextHash = createHash('sha256').update(JSON.stringify({ evidence, config: context.config, flow: testCase.flow })).digest('hex');
  let input: RunSupervisorInput | undefined;
  let entryMessages: BaseMessage[] = [];
  let result: RunSupervisorResult | undefined;
  let goal: string | null = null;
  let executions: ReturnType<typeof readCapabilityExecutions> = [];
  try {
    if (testCase.phase === 'entry') {
      const graph = createOrchestratorGraph({ models: { act: params.model, answer: params.model },
        defaultCapabilityName: context.config.defaultCapabilityName,
        runSupervisorRunner: { async invoke(captured) {
          if (input) throw new Error('Entry invoked Supervisor more than once.');
          input = captured;
          return scriptedSupervisorResult(captured, { reply: 'Evaluation capture complete.' });
        } },
      });
      const invokeInput = { messages: context.messages, context: runtimeContext, signal: config.signal };
      const result = await graph.invoke(buildOrchestratorRunInput(invokeInput.messages), {
        ...config, ...buildAgentRunnableConfig(invokeInput, { registry: context.registry }),
        recursionLimit: config.recursionLimit ?? 40,
      });
      // Exclude the scripted terminal capture from candidate evidence. Only the
      // real Entry output up to its handoff belongs to the subject.
      entryMessages = input ? [...input.messages] : result.messages;
    } else if (testCase.phase === 'boundary') {
      input = buildStudioPetBoundaryInput(testCase, context.catalog, context.messages);
      // This probe enters Supervisor directly; mirror the Root node's separate
      // invocation-context projection without rewriting the fixture's goal.
      if (runtimeContext.hint !== undefined) input = { ...input, hint: runtimeContext.hint };
    } else {
      if (!testCase.flow) throw new Error('Flow case requires controlled Capability deliveries.');
      const flow = await runStudioPetFlow({ model: params.model, registry: context.registry,
        defaultCapabilityName: context.config.defaultCapabilityName, context: runtimeContext,
        messages: context.messages, ...testCase.flow, config });
      // The graph captures raw user input before Entry. It becomes a model-set
      // goal only after Entry actually hands off to Supervisor.
      goal = flow.runSupervisorState.runId === flow.runId ? flow.runUserRequest : null;
      result = { messages: flow.messages, runSupervisorState: flow.runSupervisorState,
        capabilityDisclosure: flow.runCapabilityDisclosure ?? createCapabilityDisclosureState({ catalog: context.catalog }) };
      executions = readCapabilityExecutions(flow.messages);
    }

    if (input) result = await createRunSupervisorProbe({ model: params.model,
      defaultCapabilityName: context.config.defaultCapabilityName,
    }).invoke(input, { ...config, context: runtimeContext } as RunnableConfig);
  } catch (error) {
    throw new StudioPetRoleInvocationError(error, { output: {
      phase: testCase.phase, role: testCase.role, modelCalls: observer.read(),
      scope: 'Incomplete model invocation; recorded inputs and responses are diagnostic evidence, not a semantic verdict.',
    }, scores: [], contextHash, evaluationSummary: null });
  }

  const calls = (result?.messages ?? []).flatMap(message => AIMessage.isInstance(message) ? message.tool_calls ?? [] : []);
  const controls = calls.filter(call => isSupervisorControlTool(call.name));
  const invalidControls = controls.filter(call => { try { parseSupervisorControl(call); return false; } catch { return true; } });
  // Rejected attempts remain in the history. Only the final pending native
  // handoff is an accepted delegation captured by createRunSupervisorProbe.
  const last = result?.messages.at(-1);
  const delegations = AIMessage.isInstance(last)
    ? (last.tool_calls ?? []).filter(call => call.name === 'delegate_capability') : [];
  const current = result ? currentSupervisorTask(result.runSupervisorState) : undefined;
  const reply = result ? supervisorReply(result) : entryMessages.at(-1)?.text;
  const kind = delegations.length ? 'delegate' : reply?.trim() ? 'reply' : 'none';
  const scores: DecisionContractScore[] = [];
  const score = (key: string, statement: string, met: boolean, comment: string) => scores.push({ key, statement,
    evaluator: 'deterministic', score: met ? 1 : 0, comment });
  score('expected_decision', 'The decision delegates or replies as the case requires.',
    testCase.expected.kind === 'delegate_or_reply' ? kind === 'delegate' || kind === 'reply' : kind === testCase.expected.kind,
    `Expected ${testCase.expected.kind}; observed ${kind}.`);
  score('delegation_scope', 'A delegation targets an allowed configured Capability with an explicit briefing.',
    delegations.length === 0 || (delegations.length === 1 && Boolean(current)
      && testCase.expected.allowedCapabilities.includes(current!.capability)),
    current ? `Current Capability: ${current.capability}.` : 'No pending Capability.');
  if (testCase.phase === 'flow') score('executed_capability_scope', 'Executed delegations stay within this role’s allowed Capabilities.',
    executions.every(record => testCase.expected.allowedCapabilities.includes(record.execution.capability)),
    `${executions.length} controlled subtask deliveries; no domain actions executed.`);

  const output = {
    phase: testCase.phase, role: testCase.role, kind, goal: input?.userRequest ?? goal,
    plan: result?.runSupervisorState ?? null, reply: reply ?? null,
    entry: projectMessages(entryMessages.filter(message => message._getType() !== 'human')),
    supervisor: projectMessages(result?.messages ?? []),
    delegations: [...executions.map(record => ({ args: { briefing: record.execution.briefing }, capability: record.execution.capability })),
      ...delegations.map(call => ({ args: call.args, capability: current?.capability ?? null }))],
    executions: executions.map(({ execution, result }) => ({ execution, result })),
    protocolDiagnostics: { invalidControlAttempts: invalidControls.length },
    modelCalls: observer.read(),
    disclosedCapabilities: result?.capabilityDisclosure.disclosedCapabilityNames ?? [],
    scope: testCase.phase === 'flow'
      ? 'Production Entry, Supervisor, child and Boundary transitions with synthetic child results; no domain actions or multi-Pet publication executed.'
      : 'Scoped Channel provider and Host assembly; bounded Entry/Supervisor decision probe with explicitly supplied source excerpts. No domain actions or multi-Pet publication executed.',
  };
  try {
    const evaluation = await evaluatePromptGoal({ judge: params.judge,
      ...buildStudioPetRoleJudgmentInput(testCase, context, output) });
    return { output, scores: [...scores, ...evaluation.scores], contextHash, evaluationSummary: evaluation.summary };
  } catch (error) {
    throw new StudioPetRoleJudgeError(error, { output, scores, contextHash, evaluationSummary: null });
  }
}
