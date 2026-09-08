import { DelegationAnnounceMessage } from '../src/agent/orchestrator/delegation';
import assert from 'node:assert/strict';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { defineInstructionDocument } from '../src/types/capability.ts';
import { compileAgentRegistry } from '../src/agent/orchestrator/registry.ts';
import { createCapabilityCatalog } from '../src/agent/orchestrator/runSupervisor/capabilityCatalog.ts';
import { createCapabilityDisclosureState } from '../src/agent/orchestrator/runSupervisor/capabilityDisclosure.ts';
import { createRunSupervisorSession } from '../src/agent/orchestrator/runSupervisor/session.ts';
import { createRunSupervisorAgent } from '../src/agent/orchestrator/runSupervisor/agent.ts';
import type { RunSupervisorInput, RunSupervisorResult } from '../src/agent/orchestrator/runSupervisor/runner.ts';
import { createDecisionEvalModel } from './scripts/decision-eval-model.ts';

const configPath = process.env.PROMPT_EVAL_CONFIG_PATH ?? join(homedir(), '.pinpawo', 'config.json');
const profileId = process.env.PROMPT_EVAL_PROFILE_ID
  ?? (JSON.parse(readFileSync(configPath, 'utf8')) as { models: { defaultProfileId: string } }).models.defaultProfileId;
const subject = createDecisionEvalModel({ profileId, role: 'subject' });
// Disclosure only: this eval never dispatches a Capability or runs external work.
const executionTool = tool(() => { throw new Error('Eval must not execute real work.'); }, {
  name: 'execute_workspace_task',
  description: 'Inspect and edit workspace files, run tests, and publish release notes through the configured authenticated GitHub integration. Credentials are already available; the user chooses the destination.',
  schema: z.object({ task: z.string() }),
});
const registry = compileAgentRegistry({ toolkits: [{ name: 'workspace', description: 'Authenticated workspace execution and release publication.', tools: [{ tool: executionTool }] }], capabilities: [{
  name: 'general', description: 'Inspect files, implement changes, run tests, and publish to a user-selected destination.', uses: ['workspace'],
  instructions: defineInstructionDocument({ content: 'Execute repository work and verify results. Publication requires a destination selected by the user. Report completed operations, verification evidence, and any missing inputs.' }),
}] });
let failures = 0;
const catalog = createCapabilityCatalog({ registry });
const disclosure = { ...createCapabilityDisclosureState({ catalog }), disclosedCapabilityNames: ['general'] };
const supervisor = createRunSupervisorAgent({ model: subject.model });
const publicationPlan = [{ capability: 'general', task: 'Publish the prepared release notes after the user selects a destination.' }];
const cases: Array<{ name: string; goal: string; task?: string; evidence?: string;
  remaining?: Array<{ capability: string; task: string }>;
  supplement?: string;
  checkFollowUp?: (result: RunSupervisorResult) => void;
  check: (result: RunSupervisorResult) => void }> = [
  { name: 'entry-execution', goal: 'Inspect the repository and fix the failing unit test.', check: (result) => {
    assert.equal(result.action, 'execute_plan');
    if (result.action === 'execute_plan') { assert.ok(result.tasks.length > 0); }
  } },
  { name: 'continue-missing-verification', goal: 'Fix the bug and confirm the tests pass.',
    task: 'Fix the bug and run the test suite.', evidence: 'The patch is saved. Tests have not been run. Test tools are available; no user input or permission is needed.',
    check: (result) => { assert.equal(result.action, 'review_current');
      if (result.action === 'review_current') { assert.equal(result.completed, false); assert.ok(result.reason.trim()); } } },
  { name: 'complete-current-while-goal-has-future-work', goal: 'Investigate the bug, fix it, and verify the fix.',
    task: 'Investigate the bug and identify its cause.', evidence: 'The bug is reproduced. The cause is an off-by-one check at src/range.ts:42, confirmed by a failing regression test. The code fix is left to the next planned task.',
    remaining: [{ capability: 'general', task: 'Fix the identified off-by-one check and run the regression suite.' }],
    check: (result) => {
      assert.equal(result.action, 'review_current');
      if (result.action === 'review_current') {
        assert.equal(result.completed, true); assert.ok(result.reason.trim());
        assert.equal(result.reply, undefined); assert.equal('remainingPlan' in result, false);
      }
    } },
  { name: 'completed-task-can-ask-before-or-after-acceptance', goal: 'Prepare the release notes and publish them to a destination I will select.',
    task: 'Prepare release notes.', evidence: 'Release notes are saved to RELEASE.md and verified against the commits. Preparation is complete. Nothing has been published. The user has not selected the destination.',
    remaining: publicationPlan,
    supplement: 'Publish the prepared RELEASE.md as the GitHub release notes for pinpawo/example tag v1.2.3. I authorize publication; no further confirmation is needed.',
    check: (result) => {
      assert.ok('reply' in result && result.reply?.trim(), 'Ask the user for the missing destination.');
      if (result.action !== undefined) {
        assert.equal(result.action, 'review_current');
        if (result.action === 'review_current') {
          assert.equal(result.completed, true);
          assert.ok(result.reason.trim());
          assert.equal('remainingPlan' in result, false);
        }
      }
    },
    checkFollowUp: (result) => {
      if (result.action === 'execute_plan') {
        assert.equal(result.tasks.length, 1, 'Resume the remaining publication, without repeating preparation.');
        assert.equal(result.tasks[0].capability, 'general');
        assert.match(result.tasks[0].task, /publish|发布/i);
      } else {
        assert.equal(result.action, 'review_current');
        if (result.action === 'review_current') {
          assert.equal(result.completed, true);
          assert.equal(result.reply, undefined, 'Proceed now that the destination is supplied.');
          assert.equal('remainingPlan' in result, false);
        }
      }
    } },
  { name: 'unfinished-task-asks-then-continues', goal: 'Publish the release notes to a destination I will choose.',
    task: 'Publish the release notes after the user selects the destination.',
    evidence: 'RELEASE.md is ready. No publication has occurred: only the user can choose the destination.',
    supplement: 'Publish RELEASE.md as the GitHub release notes for pinpawo/example tag v1.2.3. I authorize publication; no further confirmation is needed.',
    check: (result) => { assert.equal(result.action, undefined); assert.ok(result.reply?.trim()); },
    checkFollowUp: (result) => {
      assert.equal(result.action, 'review_current');
      if (result.action === 'review_current') {
        assert.equal(result.completed, false, 'User input is not publication evidence.');
        assert.ok(result.reason.trim()); assert.equal(result.reply, undefined);
        assert.equal('remainingPlan' in result, false);
      }
    } },
  { name: 'entry-asks-for-user-owned-choice', goal: 'Before doing any work, ask me which release destination to use. Only I can choose it.',
    check: (result) => { assert.equal(result.action, undefined); assert.ok(result.reply?.trim()); } },
  { name: 'boundary-without-evidence-asks-user', goal: 'Publish release notes to a destination I will choose.',
    task: 'Publish the release notes to the user-selected destination.',
    check: (result) => { assert.equal(result.action, undefined); assert.ok(result.reply?.trim()); } },
  { name: 'accept-and-finish', goal: 'Fix the bug and confirm the tests pass.', task: 'Fix the bug and run the test suite.',
    evidence: 'The bug is fixed. The regression test and the full test suite passed: 42 tests, zero failures. No requested work remains.',
    check: (result) => {
      assert.equal(result.action, 'review_current');
      if (result.action === 'review_current') { assert.equal(result.completed, true); assert.ok(result.reason.trim()); assert.ok(result.reply?.trim()); assert.equal('remainingPlan' in result, false); }
    } },
];
const selected = new Set(process.env.EVAL_CASES?.split(',').filter(Boolean) ?? []);
assert.ok(selected.size === 0 || [...selected].every((name) => cases.some((scenario) => scenario.name === name)), 'Unknown EVAL_CASES entry.');
for (const scenario of cases.filter(({ name }) => selected.size === 0 || selected.has(name))) {
  const base = {
    inputId: scenario.task && !scenario.evidence ? `human:${scenario.name}` : scenario.name, traceId: scenario.name, runId: scenario.name, userRequest: scenario.goal,
    messages: [new HumanMessage(scenario.goal)], remainingPlan: scenario.remaining ?? [], catalog,
    capabilityDisclosure: disclosure,
    supervisorSession: createRunSupervisorSession({ runId: scenario.name, plan: scenario.remaining ?? [], capabilityDisclosure: disclosure }),
  };
  const input: RunSupervisorInput = scenario.task ? {
    ...base, mode: 'boundary', activeDelegation: { delegationId: 'd1', runId: scenario.name, capability: 'general', task: scenario.task },
    messages: [...base.messages, ...(scenario.evidence ? [{ messageId: 'a1', result: scenario.evidence }] : []).map((attempt) => new DelegationAnnounceMessage({
      id: 'announce:' + attempt.messageId, sourceLane: 'capability:general' as const, delegationId: 'd1', runId: scenario.name, task: scenario.task!, announceMessageId: attempt.messageId, result: attempt.result, createdAt: '2026-09-05T00:00:00Z'
    }))],

  } : { ...base, mode: 'entry', activeDelegation: null,  };
  let result: RunSupervisorResult | undefined;
  let followUp: RunSupervisorResult | undefined;
  try {
    result = await supervisor.invoke(input);
    scenario.check(result);
    if (scenario.supplement) {
      assert.ok('reply' in result && result.reply?.trim(), 'A question must precede the user supplement.');
      const accepted = result.action === 'review_current' && result.completed;
      const remainingPlan = input.remainingPlan;
      const resumed = {
        ...input, runId: `${scenario.name}:resume`, inputId: `human:${scenario.name}:resume`, remainingPlan,
        messages: [...input.messages, new AIMessage(result.reply!), new HumanMessage(scenario.supplement)],
        supervisorSession: createRunSupervisorSession({ runId: `${scenario.name}:resume`, plan: remainingPlan, capabilityDisclosure: result.capabilityDisclosure ?? disclosure }),
      };
      followUp = await supervisor.invoke(accepted
        ? { ...resumed, mode: 'entry', activeDelegation: null }
        : { ...resumed, mode: 'boundary', activeDelegation: input.activeDelegation! });
      scenario.checkFollowUp!(followUp);
    }
    console.log(JSON.stringify({ case: scenario.name, passed: true, decision: decision(result), followUp: decision(followUp) }));
  } catch (error) {
    failures += 1;
    console.log(JSON.stringify({ case: scenario.name, passed: false, error: error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.name : 'UnknownError', decision: decision(result), followUp: decision(followUp) }));
  }
}
process.exitCode = failures ? 1 : 0;

function decision(result: RunSupervisorResult | undefined) {
  if (!result) return undefined;
  const { capabilityDisclosure: _disclosure, ...proposal } = result;
  return proposal;
}
