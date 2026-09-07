import { DelegationAnnounceMessage } from '../src/agent/orchestrator/delegation';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { defineInstructionDocument } from '../src/types/capability.ts';
import { compileAgentRegistry } from '../src/agent/orchestrator/registry.ts';
import { materializeCapabilityDocumentWorkspace } from '../src/agent/orchestrator/runSupervisor/documentWorkspace.ts';
import { createCapabilityDisclosureState } from '../src/agent/orchestrator/runSupervisor/capabilityDisclosure.ts';
import { createRunSupervisorSession } from '../src/agent/orchestrator/runSupervisor/session.ts';
import { createRunSupervisorAgent } from '../src/agent/orchestrator/runSupervisor/agent.ts';
import type { RunSupervisorInput, RunSupervisorResult } from '../src/agent/orchestrator/runSupervisor/runner.ts';
import { createDecisionEvalModel } from './scripts/decision-eval-model.ts';

const configPath = process.env.PROMPT_EVAL_CONFIG_PATH ?? join(homedir(), '.pinpawo', 'config.json');
const profileId = process.env.PROMPT_EVAL_PROFILE_ID
  ?? (JSON.parse(readFileSync(configPath, 'utf8')) as { models: { defaultProfileId: string } }).models.defaultProfileId;
const subject = createDecisionEvalModel({ profileId, role: 'subject' });
const root = await mkdtemp(join(tmpdir(), 'supervisor-boundary-eval-'));
const registry = compileAgentRegistry({ toolkits: [], capabilities: [{
  name: 'general', description: 'Inspect files, implement changes, run tests, and publish to a user-selected destination.', uses: [],
  instructions: defineInstructionDocument({ content: 'Execute repository work and verify results. Publication requires a destination selected by the user. Report completed operations, verification evidence, and any missing inputs.' }),
}] });
let failures = 0;
try {
  const workspace = await materializeCapabilityDocumentWorkspace({ registry, cacheRoot: root });
  const disclosure = { ...createCapabilityDisclosureState({ workspace, maxEmptySearchRounds: 2 }), disclosedCapabilityNames: ['general'] };
  const supervisor = createRunSupervisorAgent({ model: subject.model });
  const cases: Array<{ name: string; goal: string; task?: string; evidence?: string;
    remaining?: Array<{ capability: string; task: string }>;
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
          assert.equal(result.reply, undefined); assert.equal(result.remainingPlan, undefined);
        }
      } },
    { name: 'accept-then-question', goal: 'Prepare the release notes and publish them to a destination I will select.',
      task: 'Prepare release notes.', evidence: 'Release notes are saved to RELEASE.md and verified against the commits. Preparation is complete. Nothing has been published. The user has not selected the destination.',
      remaining: [{ capability: 'general', task: 'Publish the prepared release notes after the user selects a destination.' }],
      check: (result) => {
        assert.equal(result.action, 'review_current');
        if (result.action === 'review_current') { assert.equal(result.completed, true); assert.ok(result.reason.trim()); assert.ok(result.reply?.trim()); if (result.remainingPlan) assert.equal(result.remainingPlan.length, 1); }
      } },
    { name: 'accept-and-finish', goal: 'Fix the bug and confirm the tests pass.', task: 'Fix the bug and run the test suite.',
      evidence: 'The bug is fixed. The regression test and the full test suite passed: 42 tests, zero failures. No requested work remains.',
      check: (result) => {
        assert.equal(result.action, 'review_current');
        if (result.action === 'review_current') { assert.equal(result.completed, true); assert.ok(result.reason.trim()); assert.ok(result.reply?.trim()); assert.deepEqual(result.remainingPlan ?? [], []); }
      } },
  ];
  for (const scenario of cases) {
    const base = {
      inputId: scenario.name, traceId: scenario.name, runId: scenario.name, userRequest: scenario.goal,
      messages: [new HumanMessage(scenario.goal)], remainingPlan: scenario.remaining ?? [], workspace,
      capabilityDisclosure: disclosure,
      supervisorSession: createRunSupervisorSession({ runId: scenario.name, plan: scenario.remaining ?? [], capabilityDisclosure: disclosure }),
    };
    const input: RunSupervisorInput = scenario.task ? {
      ...base, mode: 'boundary', activeDelegation: { delegationId: 'd1', runId: scenario.name, capability: 'general', task: scenario.task },
      messages: [...base.messages, ...[{ messageId: 'a1', result: scenario.evidence! }].map((attempt) => new DelegationAnnounceMessage({
        id: 'announce:' + attempt.messageId, sourceLane: 'capability:general' as const, delegationId: 'd1', runId: scenario.name, task: scenario.task!, announceMessageId: attempt.messageId, result: attempt.result, createdAt: '2026-09-05T00:00:00Z'
      }))],

    } : { ...base, mode: 'entry', activeDelegation: null,  };
    try {
      const result = await supervisor.invoke(input);
      scenario.check(result);
      console.log(JSON.stringify({ case: scenario.name, passed: true, action: result.action ?? 'reply' }));
    } catch (error) {
      failures += 1;
      console.log(JSON.stringify({ case: scenario.name, passed: false, error: error instanceof Error ? error.name : 'UnknownError' }));
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
