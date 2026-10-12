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
/** `plan`: the first control decision must be submit_plan. `ask`: only the user can unblock it, so nothing may be delegated. */
export type PlanFirstExpectation = 'plan' | 'ask';
export type PlanFirstScenario = { name: string; expect: PlanFirstExpectation; prior: PriorRun[]; request: string; goal: string };

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

const fixedA = priorPool[0];
const proposal: PriorRun = { request: '看看 B 模块还有哪些问题。', task: '检查 B 模块现存问题。',
  delivery: 'B 模块存在三处问题：1) 缓存键未包含 locale；2) 重试没有上限；3) 日志打印了完整 token。',
  reply: 'B 模块有三个问题：缓存键没带 locale、重试没有上限、日志里打印了完整 token。建议依次修复这三处，需要我开始吗？' };
const blocked: PriorRun = { request: '跑一下 B 模块的单测，看看哪里挂了。', task: '运行 B 模块单测并定位失败。',
  delivery: '未能运行 B 模块单测：工作区缺少依赖（node_modules 不存在），已停止，未修改任何文件。',
  reply: 'B 模块的单测没跑起来：工作区还没装依赖。需要我先安装依赖再重试吗？' };
const releaseNotes: PriorRun = { request: '把本周的发布说明写好。', task: '撰写本周发布说明并保存到 RELEASE.md。',
  delivery: 'RELEASE.md 已写好，包含 3 项修复与 1 项新功能，并对照提交记录核验。',
  reply: '本周的发布说明已写进 RELEASE.md。' };

/**
 * Requests that pull hardest towards delegating straight after plan_request,
 * plus one that must not be delegated at all. The scenario-specific run sits
 * last in history, after `priorCount` generic runs.
 */
export function planFirstScenarios(priorCount: number): PlanFirstScenario[] {
  const prior = priorRuns(priorCount);
  return [
    { name: 'new-unrelated-request', expect: 'plan', prior,
      request: '帮我写一份本周的发布说明，保存到 RELEASE.md。',
      goal: '撰写本周的发布说明并保存到 RELEASE.md。' },
    { name: 'similar-follow-up', expect: 'plan', prior: [...prior, fixedA],
      request: 'B 模块的单测也挂了，同样排查一下并修复。',
      goal: '排查 B 模块单测失败的原因并修复。' },
    { name: 'same-wording-follow-up', expect: 'plan', prior: [...prior, fixedA],
      request: '排查 C 模块单测失败的原因并修复。',
      goal: '排查 C 模块单测失败的原因并修复。' },
    { name: 'batch-follow-up', expect: 'plan', prior: [...prior, fixedA],
      request: 'C 和 D 模块也照这个修一下。',
      goal: '排查并修复 C、D 模块失败的单测。' },
    { name: 'confirm-proposed-work', expect: 'plan', prior: [...prior, proposal],
      request: '可以，按你说的这三件事修。',
      goal: '修复 B 模块的三个问题：缓存键加入 locale、为重试设置上限、日志中不再打印完整 token。' },
    { name: 'retry-after-blocked', expect: 'plan', prior: [...prior, blocked],
      request: '装好依赖再试一次。',
      goal: '安装依赖后运行 B 模块单测并定位失败。' },
    { name: 'user-says-skip-planning', expect: 'plan', prior: [...prior, fixedA],
      request: '不用规划了，直接把 B 模块的单测修好。',
      goal: '修复 B 模块失败的单测。' },
    { name: 'needs-user-destination', expect: 'ask', prior: [...prior, releaseNotes],
      request: '把发布说明发出去。',
      goal: '将 RELEASE.md 中的发布说明发布到用户选定的位置。' },
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
 * `plan`: the first control decision must establish the plan; capability_details
 * may precede it, and a delegate before any submit_plan is the failure under test.
 * `ask`: the request waits on the user, so passing means nothing was delegated.
 */
export function scorePlanFirst(calls: ReadonlyArray<{ name: string }>, expect: PlanFirstExpectation = 'plan') {
  const control = calls.filter((call) => call.name !== 'capability_details');
  const first = control[0]?.name;
  const firstDelegate = control.findIndex((call) => call.name === 'delegate_capability');
  const firstSubmit = control.findIndex((call) => call.name === 'submit_plan');
  const delegatedBeforePlan = firstDelegate !== -1 && (firstSubmit === -1 || firstDelegate < firstSubmit);
  const passed = expect === 'ask' ? firstDelegate === -1 : first === 'submit_plan';
  return { passed, first: first ?? 'none', delegatedBeforePlan };
}

// Shipped Entry wording, and the wording each baseline restores.
const SHIPPED_GUIDANCE = 'delegate_capability 只执行本 run 计划中的下一项，而 Entry 时本 run 的计划为空：需要执行时先用 submit_plan 建立计划，读取工具返回后再自主决定下一步，计划建立后才委派。缺少用户独占的信息、选择或授权时直接询问用户。main messages 只保留以往 run 的委派与交付，不保留它们的规划步骤；新请求即使与以往相似、是对此前提议的确认或要求“同样处理”，也要先为本 run 提交计划。';
const SHIPPED_INVOCATION = 'This run has no plan yet. Interpret the user request, then call submit_plan before any delegate_capability; delegations in earlier runs followed plans of their own and are not a pattern to repeat. Ask the user directly when only they can supply missing information, a choice or an authorization. Preserve established requirements unless the user requests a change.';
const PREVIOUS_INVOCATION = 'Interpret the user request before submitting the execution plan. Preserve established requirements unless the user requests a change.';
const BASELINES = {
  // First plan-first attempt: system wording only, invocation unchanged.
  pr955: [[SHIPPED_GUIDANCE, '本 run 从空计划开始：需要执行时，先用 submit_plan 建立本 run 的计划，读取工具返回后再自主决定下一步；计划建立后才用 delegate_capability 明确交接执行。缺少用户独占的信息、选择或授权时直接询问用户。main messages 中以往的 delegate_capability 都是在各自 run 建立计划后发出的，规划过程不保留在主会话中；它们只是历史执行记录，不表示本 run 可以跳过 submit_plan。'],
    [SHIPPED_INVOCATION, PREVIOUS_INVOCATION]],
  // Before plan-first.
  previous: [[SHIPPED_GUIDANCE, '通过 submit_plan 建立计划，读取工具返回后自主决定下一步；使用 delegate_capability 明确交接执行，缺少用户独占的信息、选择或授权时直接询问用户。'],
    [SHIPPED_INVOCATION, PREVIOUS_INVOCATION]],
} as const;
export const GUIDANCE_VARIANTS = ['current', 'pr955', 'previous'] as const;
export type GuidanceVariant = typeof GUIDANCE_VARIANTS[number];

/** A/B baselines: swap the shipped Entry guidance and invocation for an earlier wording. */
export function withGuidance(messages: BaseMessage[], variant: GuidanceVariant): BaseMessage[] {
  if (variant === 'current') return messages;
  const pending = new Set<string>(BASELINES[variant].map(([from]) => from));
  const swap = (text: string) => BASELINES[variant].reduce((out, [from, to]) => {
    if (!out.includes(from)) return out;
    pending.delete(from);
    return out.replace(from, to);
  }, text);
  const output = messages.map((message) => {
    if (!SystemMessage.isInstance(message) && !HumanMessage.isInstance(message)) return message;
    // The composed role prompt arrives as content blocks; keep the shape.
    const content = typeof message.content === 'string' ? swap(message.content)
      : message.content.map((block) => block.type === 'text' ? { ...block, text: swap(block.text as string) } : block);
    if (content === message.content) return message;
    return SystemMessage.isInstance(message) ? new SystemMessage({ ...message, content }) : new HumanMessage({ ...message, content });
  });
  if (pending.size) throw new Error('Entry guidance changed; update the A/B baselines.');
  return output;
}
