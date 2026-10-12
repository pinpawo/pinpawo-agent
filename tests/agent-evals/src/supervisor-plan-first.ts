import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { setAgentMessageMetadata } from '../../../packages/pet-agent/src/agent/messages';
import { createCapabilityExecutionMessage } from '../../../packages/pet-agent/src/agent/orchestrator/executionMessages';
import { compileAgentRegistry } from '../../../packages/pet-agent/src/agent/orchestrator/registry';
import { createCapabilityCatalog } from '../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/capabilityCatalog';
import { createCapabilityDisclosureState } from '../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/capabilityDisclosure';
import type { RunSupervisorInput } from '../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/runner';
import { PLAN_REQUEST_TOOL_NAME } from '../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/entryAnswer';
import { defineInstructionDocument } from '../../../packages/pet-agent/src/types/capability';

/**
 * Main history as a new run's Supervisor sees it: every earlier run reads
 * "plan_request → delegate_capability", because each run's submit_plan lives in
 * the Supervisor lane that prepare removes once the next run starts.
 */

// Disclosure only: the probe captures delegation and never runs this tool.
const executionTool = tool(() => { throw new Error('Eval must not execute real work.'); }, {
  name: 'execute_workspace_task',
  description: 'Inspect and edit workspace files, run tests and commands.',
  schema: z.object({ task: z.string() }),
});
const registry = compileAgentRegistry({
  toolkits: [{ name: 'workspace', description: 'Workspace file, shell and test execution.', tools: [{ tool: executionTool }] }],
  capabilities: [{
    name: 'general', description: 'Inspect files, implement changes, run tests and commands, and write documents.', uses: ['workspace'],
    instructions: defineInstructionDocument({ content: 'Execute workspace work and verify results. Report completed operations, verification evidence and any missing inputs.' }),
  }],
});
export const planFirstCatalog = createCapabilityCatalog({ registry });

export type PriorRun = { request: string; task: string; delivery: string; reply: string };
export type PlanFirstScenario = { name: string; prior: PriorRun[]; request: string; goal: string };

const priorPool: PriorRun[] = [
  { request: '排查 A 模块单测失败的原因并修复。', task: '排查并修复 A 模块失败的单测。',
    delivery: 'A 模块 parseRange 越界判断有误，已修复 src/a/range.ts:42，A 模块 18 个测试全部通过。',
    reply: 'A 模块的单测已修好：越界判断写反了，修复后 18 个测试全部通过。' },
  { request: '把 README 的安装步骤更新成 Node 24。', task: '将 README 安装步骤更新为 Node 24。',
    delivery: 'README 安装章节已改为 Node 24，并补充 nvm 用法；链接已检查。',
    reply: 'README 已更新为 Node 24 的安装步骤，并加了 nvm 的用法。' },
  { request: '检查 package.json 里的 scripts 和构建入口是否一致。', task: '核对 package.json scripts 与构建入口。',
    delivery: 'scripts.build 指向 tsup.config.ts，入口 src/index.ts 与 exports 一致，无需修改。',
    reply: '核对过了，scripts 和构建入口一致，不需要改。' },
  { request: '给 CHANGELOG 加上本周的修复记录。', task: '在 CHANGELOG 中补充本周修复记录。',
    delivery: 'CHANGELOG.md 新增 2026-10-12 条目，列出 3 项修复并附 PR 链接。',
    reply: 'CHANGELOG 已补上本周的 3 项修复。' },
];

export function priorRuns(count: number): PriorRun[] {
  return Array.from({ length: count }, (_, i) => priorPool[i % priorPool.length]);
}

const proposal: PriorRun = { request: '看看 B 模块还有哪些问题。', task: '检查 B 模块现存问题。',
  delivery: 'B 模块存在三处问题：1) 缓存键未包含 locale；2) 重试没有上限；3) 日志打印了完整 token。',
  reply: 'B 模块有三个问题：缓存键没带 locale、重试没有上限、日志里打印了完整 token。建议依次修复这三处，需要我开始吗？' };

/** Scenarios that pull hardest towards delegating straight after plan_request. */
export function planFirstScenarios(priorCount: number): PlanFirstScenario[] {
  const prior = priorRuns(priorCount);
  return [
    { name: 'new-unrelated-request', prior,
      request: '帮我写一份本周的发布说明，保存到 RELEASE.md。',
      goal: '撰写本周的发布说明并保存到 RELEASE.md。' },
    { name: 'similar-follow-up', prior: [...prior, priorPool[0]],
      request: 'B 模块的单测也挂了，同样排查一下并修复。',
      goal: '排查 B 模块单测失败的原因并修复。' },
    { name: 'confirm-proposed-work', prior: [...prior, proposal],
      request: '可以，按你说的这三件事修。',
      goal: '修复 B 模块的三个问题：缓存键加入 locale、为重试设置上限、日志中不再打印完整 token。' },
  ];
}

function priorRunMessages(run: PriorRun, index: number): BaseMessage[] {
  const runId = `prior-${index}`;
  const metadata = { runId, taskId: runId };
  const planCall = `plan-request:${runId}`;
  const delegateCall = `delegate:${runId}`;
  return [
    setAgentMessageMetadata(new HumanMessage(run.request), metadata),
    setAgentMessageMetadata(new AIMessage({ content: '', tool_calls: [{
      id: planCall, name: PLAN_REQUEST_TOOL_NAME, type: 'tool_call', args: { goal: run.request },
    }] }), metadata),
    setAgentMessageMetadata(new ToolMessage({ name: PLAN_REQUEST_TOOL_NAME, tool_call_id: planCall,
      content: 'Request handed to Supervisor.' }), metadata),
    setAgentMessageMetadata(new AIMessage({ content: `我来${run.task}`, tool_calls: [{
      id: delegateCall, name: 'delegate_capability', type: 'tool_call', args: { briefing: run.task },
    }] }), { ...metadata, source: 'supervisor' }),
    createCapabilityExecutionMessage({ callId: delegateCall, metadata,
      execution: { planItemId: `${runId}:task`, delegationId: `${runId}:delegation`, capability: 'general', task: run.task, briefing: run.task },
      result: { status: 'returned', artifacts: [], delivery: { id: `delivery:${runId}`, task: run.task, text: run.delivery,
        scope: { ...metadata, lane: 'capability:general', delegationId: `${runId}:delegation` } } } }),
    setAgentMessageMetadata(new AIMessage(run.reply), metadata),
  ];
}

/** Entry-mode input for a new run after Entry's plan_request, which clears the saved plan. */
export function planFirstInput(scenario: PlanFirstScenario, runId: string): RunSupervisorInput {
  const metadata = { runId, taskId: runId };
  const planCall = `plan-request:${runId}`;
  return {
    mode: 'entry', inputId: `entry:${runId}:0`, runId, taskId: runId, userRequest: scenario.goal,
    catalog: planFirstCatalog,
    capabilityDisclosure: { ...createCapabilityDisclosureState({ catalog: planFirstCatalog }), disclosedCapabilityNames: ['general'] },
    state: { runId: null, goal: null, plan: [] },
    messages: [
      ...scenario.prior.flatMap(priorRunMessages),
      setAgentMessageMetadata(new HumanMessage(scenario.request), metadata),
      setAgentMessageMetadata(new AIMessage({ content: '', tool_calls: [{
        id: planCall, name: PLAN_REQUEST_TOOL_NAME, type: 'tool_call', args: { goal: scenario.goal },
      }] }), metadata),
      setAgentMessageMetadata(new ToolMessage({ name: PLAN_REQUEST_TOOL_NAME, tool_call_id: planCall,
        content: 'Request handed to Supervisor.' }), metadata),
    ],
  };
}

/**
 * The first control decision must establish the plan. capability_details may
 * precede it; a delegate before any submit_plan is the failure under test.
 */
export function scorePlanFirst(calls: ReadonlyArray<{ name: string }>) {
  const control = calls.filter((call) => call.name !== 'capability_details');
  const first = control[0]?.name;
  const firstDelegate = control.findIndex((call) => call.name === 'delegate_capability');
  const firstSubmit = control.findIndex((call) => call.name === 'submit_plan');
  const delegatedBeforePlan = firstDelegate !== -1 && (firstSubmit === -1 || firstDelegate < firstSubmit);
  return { passed: first === 'submit_plan', first: first ?? 'none', delegatedBeforePlan };
}

const CURRENT_GUIDANCE = '本 run 从空计划开始：需要执行时，先用 submit_plan 建立本 run 的计划，读取工具返回后再自主决定下一步；计划建立后才用 delegate_capability 明确交接执行。缺少用户独占的信息、选择或授权时直接询问用户。main messages 中以往的 delegate_capability 都是在各自 run 建立计划后发出的，规划过程不保留在主会话中；它们只是历史执行记录，不表示本 run 可以跳过 submit_plan。';
const PREVIOUS_GUIDANCE = '通过 submit_plan 建立计划，读取工具返回后自主决定下一步；使用 delegate_capability 明确交接执行，缺少用户独占的信息、选择或授权时直接询问用户。';
export type GuidanceVariant = 'current' | 'previous';

/** A/B baseline: swap the shipped Entry guidance for the wording before plan-first. */
export function withGuidance(messages: BaseMessage[], variant: GuidanceVariant): BaseMessage[] {
  if (variant === 'current') return messages;
  let replaced = false;
  const swap = (text: string) => {
    if (!text.includes(CURRENT_GUIDANCE)) return text;
    replaced = true;
    return text.replace(CURRENT_GUIDANCE, PREVIOUS_GUIDANCE);
  };
  const output = messages.map((message) => {
    if (!SystemMessage.isInstance(message)) return message;
    // The composed role prompt arrives as content blocks; keep the shape.
    const content = typeof message.content === 'string' ? swap(message.content)
      : message.content.map((block) => block.type === 'text' ? { ...block, text: swap(block.text as string) } : block);
    return new SystemMessage({ ...message, content });
  });
  if (!replaced) throw new Error('Entry guidance changed; update the A/B baseline.');
  return output;
}
