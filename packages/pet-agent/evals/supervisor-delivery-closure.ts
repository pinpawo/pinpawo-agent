import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { defineInstructionDocument } from '../src/types/capability';
import { compileAgentRegistry } from '../src/agent/orchestrator/registry';
import { createCapabilityCatalog } from '../src/agent/orchestrator/runSupervisor/capabilityCatalog';
import { supervisorFixture } from './supervisor-fixtures';
import { acceptSupervisorMessageHandoff } from '../src/agent/orchestrator/runSupervisor/messageHandoff';
import { supervisorHandoffContext } from '../src/agent/orchestrator/runSupervisor/input';
import { readCapabilityExecutionCall } from '../src/agent/orchestrator/executionMessages';
import type { RunSupervisorInput, RunSupervisorResult } from '../src/agent/orchestrator/runSupervisor/runner';
import type { ClosureExample, ClosureExpected } from './datasets/supervisor-delivery-closure';

const registry = compileAgentRegistry({ toolkits: [], capabilities: [
  { name: 'studio_review', description: '独立审查代码与交付证据，产出供检查与看板反馈使用的审查结论。', uses: [], instructions: defineInstructionDocument({ content: '使用只读文件工具和 task_list/task_start 进行独立核验，返回具体结论与证据。审查没有提交结果的工具。结果返回后由 Supervisor 判断后续安排。' }) },
  { name: 'studio_reporting', description: '将已检查的完整交付或明确阻塞反馈到看板，供用户及后续工作读取。', uses: [], instructions: defineInstructionDocument({ content: '使用 task_list 确认目标，使用 task_complete 提交完整结果或 task_block 报告阻塞。按实际回执报告写入结果。不执行文件核验。' }) },
] });
const catalog = createCapabilityCatalog({ registry });
export function closureInput(example: ClosureExample, id: string): RunSupervisorInput {
  const input = supervisorFixture({ catalog, runId: id, ...example });
  // All responsibilities are disclosed: isolates goal closure from document retrieval.
  return { ...input, capabilityDisclosure: { ...input.capabilityDisclosure, disclosedCapabilityNames: example.disclosure === 'manifest' ? [] : [...catalog.capabilityNames] },
    state: { ...input.state, plan: [
      ...(example.capability === 'studio_reporting' ? [{ id: 'review-accepted', capability: 'studio_review', task: '独立复核三个配置文件并返回完整结论。', status: 'completed' as const }] : []),
      ...(example.staleCompletion ? [{ id: 'old-review', capability: 'studio_review', task: '复核任务 T-OLD 并将结果提交看板。', status: 'completed' as const }] : []),
      ...input.state.plan,
    ] },
    messages: example.staleCompletion ? [
    new HumanMessage('上一轮任务 T-OLD 的审阅结果需要写入看板。'),
    new AIMessage('上一轮 T-OLD 已成功写入看板，状态 done。'),
    ...input.messages,
  ] : input.messages };
}
export function scoreClosure(input: RunSupervisorInput, result: RunSupervisorResult, expected: ClosureExpected) {
  const accepted = acceptSupervisorMessageHandoff(supervisorHandoffContext(input), result.messages);
  const dispatch = result.messages.map(readCapabilityExecutionCall).find(record => record !== null);
  const actual = dispatch ? dispatch.execution.capability === 'studio_reporting' ? 'report' : 'review' : result.reply?.trim() ? 'reply' : 'none';
  const adjustments = result.messages.flatMap(m => AIMessage.isInstance(m) ? m.tool_calls ?? [] : []).filter(c => c.name === 'adjust_plan').length;
  const completed = input.state.plan.filter(t => t.status === 'completed');
  const reintroducedCompleted = accepted.runSupervisorState.plan.some(t => t.status === 'pending'
    && completed.some(old => old.capability === t.capability && old.task === t.task));
  return { passed: actual === expected.action && !reintroducedCompleted
      && (expected.maxAdjustments === undefined || adjustments <= expected.maxAdjustments),
    actual, expected: expected.action, adjustments, maxAdjustments: expected.maxAdjustments, reintroducedCompleted,
    plan: accepted.runSupervisorState.plan, reply: result.reply,
    dispatch: dispatch?.execution };
}
