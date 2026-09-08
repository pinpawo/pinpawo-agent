import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { compileAgentRegistry } from '../src/agent/orchestrator/registry.ts';
import { defineInstructionDocument } from '../src/types/capability.ts';
import { DelegationAnnounceMessage } from '../src/agent/orchestrator/delegation/index.ts';
import { materializeCapabilityDocumentWorkspace } from '../src/agent/orchestrator/runSupervisor/documentWorkspace.ts';
import { createCapabilityDisclosureState } from '../src/agent/orchestrator/runSupervisor/capabilityDisclosure.ts';
import { createRunSupervisorSession } from '../src/agent/orchestrator/runSupervisor/session.ts';
import { createRunSupervisorAgent } from '../src/agent/orchestrator/runSupervisor/agent.ts';
import type { RunSupervisorInput, RunSupervisorResult } from '../src/agent/orchestrator/runSupervisor/runner.ts';
import { createDecisionEvalModel } from './scripts/decision-eval-model.ts';
import { createSupervisorSearchDiagnostics } from './supervisor-search-diagnostics.ts';

// Isolated responsibility names make each search budget interpretable. These are
// eval expectations, not production search limits or instructions to the model.
const capabilities = [
  ['repository', 'Read and edit repository source, investigate bugs and run tests.'],
  ['release_publisher', 'Publish prepared release notes to the destination selected by the user.'],
  ['calendar', 'Read and organize calendar events.'],
  ['image_editor', 'Edit images and illustrations.'],
  ['spreadsheet', 'Read spreadsheets and calculate spreadsheet formulas.'],
];
const execution = tool(() => { throw new Error('Search eval must not execute business tools.'); }, {
  name: 'execute_task', description: 'Perform the selected Capability responsibility.', schema: z.object({ task: z.string() }),
});
const registry = compileAgentRegistry({
  toolkits: [{ name: 'execution', description: 'Execute the selected responsibility.', tools: [{ tool: execution }] }],
  capabilities: capabilities.map(([name, description]) => ({ name, description, uses: ['execution'],
    instructions: defineInstructionDocument({ content: `${description} Report actual delivery and evidence. Only the user chooses a publication destination.` }),
  })),
});
type Scenario = {
  name: string; goal: string; disclosed: string[]; maxCalls: number; expected: 'plan' | 'reply' | 'accept' | 'continue';
  required?: string[]; evidence?: string;
};
const scenarios: Scenario[] = [
  { name: 'entry-exact-capability', goal: 'Use repository to fix the failing unit test and verify it.', disclosed: [], maxCalls: 1, expected: 'plan', required: ['repository'] },
  { name: 'entry-disclosed-capability', goal: 'Fix the failing unit test and verify it.', disclosed: ['repository'], maxCalls: 0, expected: 'plan', required: ['repository'] },
  { name: 'entry-two-responsibilities', goal: 'Use repository to prepare release notes, then release_publisher to publish them to the GitHub release for example/repo tag v1.0. I authorize publication.', disclosed: [], maxCalls: 2, expected: 'plan', required: ['repository', 'release_publisher'] },
  { name: 'entry-user-choice-before-work', goal: 'Before doing any work, ask me which release destination to use. Only I can choose it.', disclosed: [], maxCalls: 0, expected: 'reply' },
  { name: 'boundary-accept-no-discovery', goal: 'Fix the bug and run tests.', disclosed: ['repository'], maxCalls: 0, expected: 'accept', evidence: 'Bug fixed; regression test and full suite passed, 42 tests, zero failures. All requested work is delivered.' },
  { name: 'boundary-continue-no-discovery', goal: 'Fix the bug and run tests.', disclosed: ['repository'], maxCalls: 0, expected: 'continue', evidence: 'Patch saved, but tests have not run. Test tools are available. No user information or permission is missing.' },
];
const config = JSON.parse(await readFile(process.env.PROMPT_EVAL_CONFIG_PATH ?? join(homedir(), '.pinpawo/config.json'), 'utf8'));
const profileId = process.env.PROMPT_EVAL_PROFILE_ID ?? config.models.defaultProfileId;
const subject = createDecisionEvalModel({ profileId, role: 'subject' });
const repeats = Number(process.env.SEARCH_EVAL_REPEATS ?? 1);
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('SEARCH_EVAL_REPEATS must be a positive integer.');
const selectedNames = process.env.EVAL_CASES?.split(',').filter(Boolean) ?? [];
if (selectedNames.some((name) => !scenarios.some((scenario) => scenario.name === name))) throw new Error('Unknown EVAL_CASES entry.');
const selected = scenarios.filter(({ name }) => !selectedNames.length || selectedNames.includes(name));
const root = await mkdtemp(join(tmpdir(), 'supervisor-search-eval-'));
const results = [];
try {
  const workspace = await materializeCapabilityDocumentWorkspace({ registry, cacheRoot: root });
  for (const scenario of selected) for (let repeat = 1; repeat <= repeats; repeat++) {
    // Fresh runner per case: first-use routing-manifest cost is visible, not
    // silently amortized across cases. Model timings include that preparation.
    const supervisor = createRunSupervisorAgent({ model: subject.model });
    const trace = createSupervisorSearchDiagnostics();
    const disclosure = { ...createCapabilityDisclosureState({ workspace, maxEmptySearchRounds: 2 }), disclosedCapabilityNames: scenario.disclosed };
    const base = { inputId: scenario.name, traceId: scenario.name, runId: scenario.name, userRequest: scenario.goal,
      messages: [new HumanMessage(scenario.goal)], remainingPlan: [], workspace, capabilityDisclosure: disclosure,
      supervisorSession: createRunSupervisorSession({ runId: scenario.name, capabilityDisclosure: disclosure }),
    };
    const input: RunSupervisorInput = scenario.evidence ? { ...base, mode: 'boundary',
      activeDelegation: { delegationId: 'd1', runId: scenario.name, capability: 'repository', task: scenario.goal },
      messages: [...base.messages, new DelegationAnnounceMessage({ id: 'announce:a1', sourceLane: 'capability:repository',
        delegationId: 'd1', runId: scenario.name, task: scenario.goal, announceMessageId: 'a1', result: scenario.evidence, createdAt: '2026-09-08T00:00:00Z' })],
    } : { ...base, mode: 'entry', activeDelegation: null };
    let decision: RunSupervisorResult | undefined; let error;
    try { decision = await supervisor.invoke(input, { callbacks: trace.callbacks }); }
    catch (caught) { error = { name: caught instanceof Error ? caught.name : 'UnknownError' }; }
    const diagnostics = trace.read();
    const behaviorPassed = scenario.expected === 'plan'
      ? decision?.action === 'execute_plan' && scenario.required!.every((name) => decision.tasks.some((task) => task.capability === name))
      : scenario.expected === 'reply' ? decision?.action === undefined && Boolean(decision?.reply?.trim())
      : decision?.action === 'review_current' && decision.completed === (scenario.expected === 'accept')
        && (scenario.expected === 'accept' ? Boolean(decision.reply?.trim()) : !decision.reply);
    const searchBudgetPassed = diagnostics.searchCalls <= scenario.maxCalls && diagnostics.repeatedQueries === 0;
    const result = { case: scenario.name, mode: input.mode, repeat, passed: !error && behaviorPassed && searchBudgetPassed,
      behaviorPassed, searchBudgetPassed, maxSearchCalls: scenario.maxCalls,
      decision: decision ? Object.fromEntries(Object.entries(decision).filter(([key]) => key !== 'capabilityDisclosure')) : null,
      error, diagnostics };
    results.push(result);
    console.log(JSON.stringify(result));
  }
} finally { await rm(root, { recursive: true, force: true }); }
const path = resolve(process.env.SEARCH_EVAL_REPORT_PATH ?? join(tmpdir(), `supervisor-search-${profileId}.json`));
await writeFile(path, JSON.stringify({ model: subject.metadata, repeats, results }, null, 2) + '\n');
console.log(`Passed ${results.filter(({ passed }) => passed).length}/${results.length}; report: ${path}`);
if (results.some(({ passed }) => !passed)) process.exitCode = 1;
