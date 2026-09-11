import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { defineInstructionDocument } from '../src/types/capability.ts';
import { compileAgentRegistry } from '../src/agent/orchestrator/registry.ts';
import { createCapabilityCatalog } from '../src/agent/orchestrator/runSupervisor/capabilityCatalog.ts';
import { createCapabilityDisclosureState } from '../src/agent/orchestrator/runSupervisor/capabilityDisclosure.ts';
import { createRunSupervisorAgent } from '../src/agent/orchestrator/runSupervisor/agent.ts';
import { acceptSupervisorMessageHandoff } from '../src/agent/orchestrator/runSupervisor/messageHandoff.ts';
import { supervisorHandoffContext } from '../src/agent/orchestrator/runSupervisor/input.ts';
import { supervisorFixture, readSupervisorDecision } from './supervisor-fixtures';
import type { RunSupervisorInput } from '../src/agent/orchestrator/runSupervisor/runner.ts';
import { createDecisionEvalModel } from './scripts/decision-eval-model.ts';

// Synthetic decisions only: no Capability is dispatched and no work is executed.
const configPath = process.env.PROMPT_EVAL_CONFIG_PATH ?? join(homedir(), '.pinpawo', 'config.json');
const profileId = process.env.PROMPT_EVAL_PROFILE_ID
  ?? (JSON.parse(readFileSync(configPath, 'utf8')) as { models: { defaultProfileId: string } }).models.defaultProfileId;
const subject = createDecisionEvalModel({ profileId, role: 'subject' });
const catalog = createCapabilityCatalog({ registry: compileAgentRegistry({ toolkits: [], capabilities: [
  { name: 'general', description: 'Inspect and modify repositories.', uses: [],
    instructions: defineInstructionDocument({ content: 'Inspect and modify repository files and verify the results.' }) },
  { name: 'writer', description: 'Write reports from supplied evidence.', uses: [],
    instructions: defineInstructionDocument({ content: 'Write private reports from supplied evidence.' }) },
] }) });
const disclosure = { ...createCapabilityDisclosureState({ catalog }), disclosedCapabilityNames: catalog.capabilityNames };
const supervisor = createRunSupervisorAgent({ model: subject.model });
const goal = 'Inspect the example/old repository and publish the findings.';
const cases = [
  { name: 'entry',
    goal: '根据已提供的迁移检查结果撰写中文内部报告，以 Markdown 正文交付。已确认：配置文件迁移完成；42 项回归测试全部通过；尚未进行线上压测。报告包含迁移结论、验证证据及待验证风险，明确区分已验证和未验证事项。',
    guidance: '检查结果已经完整提供，不需要再调查仓库。请开始撰写内部报告，仅在当前对话交付正文，不涉及保存文件或发布。' },
  { name: 'continue', guidance: '项目看错了。改为 example/correct；沿用当前 general delegation 的调查记录，修正当前任务和计划，只检查迁移说明，然后写内部报告，不要发布。', strategy: 'continue', capability: 'general' },
  { name: 'replace', guidance: '停止旧项目调查，保留旧记录但不要再使用旧 delegation 的私有上下文。我已提供结论：迁移已完成、测试通过。请新建 writer delegation，直接据此写内部报告。不要发布，也不需要再确认。', strategy: 'replace', capability: 'writer' },
  { name: 'clarify', guidance: '计划改一下，目标换成另外那个，具体选哪个我等下告诉你。现在先问我，不要继续执行。' },
];
let failures = 0;
const selected = new Set(process.env.EVAL_CASES?.split(',').filter(Boolean) ?? []);
assert.ok([...selected].every((name) => cases.some((scenario) => scenario.name === name)), 'Unknown EVAL_CASES entry.');
for (const scenario of cases.filter(({ name }) => selected.size === 0 || selected.has(name))) {
  const userRequest = scenario.goal ?? goal;
  const remainingPlan = scenario.name === 'entry' ? [] : [{ capability: 'general', task: 'Publish the findings.' }];
  const fixture = supervisorFixture({ catalog, runId: scenario.name, goal: userRequest, freshUserInput: true,
    task: scenario.name === 'entry' ? undefined : 'Inspect the example/old repository.', remaining: remainingPlan });
  const input: RunSupervisorInput = { ...fixture, capabilityDisclosure: disclosure,
    messages: [...fixture.messages, new HumanMessage(scenario.guidance)] };
  try {
    const actual = await supervisor.invoke(input);
    const result = readSupervisorDecision(actual);
    console.log(JSON.stringify({ case: scenario.name, decision: result }));
    if (scenario.name === 'entry') {
      assert.equal(result.action, 'execute_plan');
      if (result.action === 'execute_plan') {
        assert.ok(result.tasks.length > 0);
        assert.equal(result.tasks[0].capability, 'writer');
      }
    } else if (scenario.strategy) {
      assert.equal(result.action, 'adjust_plan');
      if (result.action === 'adjust_plan') {
        assert.equal(result.currentDelegation, scenario.strategy);
        assert.equal(result.tasks[0].capability, scenario.capability);
        assert.ok(result.tasks.length > 0);
      }
    } else {
      assert.ok(result.reply?.trim());
      // Asking may use a direct answer or a no-execution review reply. The
      // observable contract is unchanged work and no Capability dispatch.
      if (actual.reply === undefined) {
        const accepted = acceptSupervisorMessageHandoff(supervisorHandoffContext(input), actual.messages);
        assert.deepEqual(accepted.runSupervisorState, input.state);
        assert.ok(accepted.reply?.trim());
        assert.equal(accepted.messages.length, 2);
      }
    }
    console.log(JSON.stringify({ case: scenario.name, passed: true }));
  } catch (error) {
    failures++;
    console.log(JSON.stringify({ case: scenario.name, passed: false,
      error: error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : 'UnknownError' }));
  }
}
process.exitCode = failures ? 1 : 0;
