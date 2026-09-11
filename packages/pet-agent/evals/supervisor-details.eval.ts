import { writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { compileAgentRegistry } from '../src/agent/orchestrator/registry.ts';
import { defineInstructionDocument } from '../src/types/capability.ts';
import { DelegationAnnounceMessage } from '../src/agent/orchestrator/delegation/index.ts';
import { createCapabilityCatalog } from '../src/agent/orchestrator/runSupervisor/capabilityCatalog.ts';
import { createCapabilityDisclosureState } from '../src/agent/orchestrator/runSupervisor/capabilityDisclosure.ts';
import { supervisorFixture, readSupervisorDecision, type SupervisorDecision } from './supervisor-fixtures';
import { createRunSupervisorAgent } from '../src/agent/orchestrator/runSupervisor/agent.ts';
import type { RunSupervisorInput, RunSupervisorResult } from '../src/agent/orchestrator/runSupervisor/runner.ts';
import { createDecisionEvalModel } from './scripts/decision-eval-model.ts';
import { createSupervisorDetailsDiagnostics } from './supervisor-details-diagnostics.ts';

// Isolated responsibility names make each disclosure budget interpretable. These are
// eval expectations, not production discovery limits or instructions to the model.
const capabilities = [
  ['repository', 'Read and edit repository source, investigate bugs and run tests.'],
  ['release_publisher', 'Publish prepared release notes to the destination selected by the user.'],
  ['calendar', 'Read and organize calendar events.'],
  ['image_editor', 'Edit images and illustrations.'],
  ['spreadsheet', 'Read spreadsheets and calculate spreadsheet formulas.'],
];
const execution = tool(() => { throw new Error('Details eval must not execute business tools.'); }, {
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
// Synthetic executor reports: these describe fixture deliveries, not changes
// made in this repository. Keep the completed/pending pair on the same task.
const boundaryGoal = 'In the checkout project, fix calculateSubtotal in src/cart.ts: '
  + 'it currently adds item.quantity instead of item.price * item.quantity. '
  + 'For [{ price: 12, quantity: 3 }, { price: 5, quantity: 2 }], return 46 instead of 5. '
  + 'Add a regression test in tests/cart.test.ts and run both that test file and the full npm test suite. '
  + 'Report the change and test results. No commit, publication or deployment is requested.';
const boundaryPatchReport = [
  'Located the bug in src/cart.ts, calculateSubtotal: the reducer added item.quantity and ignored item.price.',
  'Changed the reducer from sum + item.quantity to sum + item.price * item.quantity; retained the initial accumulator 0.',
  'Added tests/cart.test.ts case "multiplies each item price by quantity": input [{ price: 12, quantity: 3 }, { price: 5, quantity: 2 }], expected 46.',
  'Before the fix, npm test -- tests/cart.test.ts exited 1: this regression expected 46 but received 5; the other 3 tests passed.',
].join('\n');
const scenarios: Scenario[] = [
  { name: 'entry-exact-capability', goal: 'Use repository to fix the failing unit test and verify it.', disclosed: [], maxCalls: 0, expected: 'plan', required: ['repository'] },
  { name: 'entry-disclosed-capability', goal: 'Fix the failing unit test and verify it.', disclosed: ['repository'], maxCalls: 0, expected: 'plan', required: ['repository'] },
  { name: 'entry-two-responsibilities', goal: 'Use repository to prepare release notes, then release_publisher to publish them to the GitHub release for example/repo tag v1.0. I authorize publication.', disclosed: [], maxCalls: 0, expected: 'plan', required: ['repository', 'release_publisher'] },
  { name: 'entry-requested-details', goal: 'Read the full repository Capability details first, then use it to fix the failing unit test and verify the fix.', disclosed: [], maxCalls: 1, expected: 'plan', required: ['repository'] },
  { name: 'entry-user-choice-before-work', goal: 'Before doing any work, ask me which release destination to use. Only I can choose it.', disclosed: [], maxCalls: 0, expected: 'reply' },
  { name: 'boundary-accept-no-discovery', goal: boundaryGoal, disclosed: ['repository'], maxCalls: 0, expected: 'accept', evidence: [
    boundaryPatchReport,
    'After the fix, npm test -- tests/cart.test.ts exited 0: Test Files 1 passed (1); Tests 4 passed (4), including the new regression.',
    'Then npm test exited 0: Test Files 8 passed (8); Tests 42 passed (42); no failures or skipped tests.',
    'Working tree changes are limited to src/cart.ts and tests/cart.test.ts. The patch is saved locally; no commit or deployment was made.',
  ].join('\n') },
  { name: 'boundary-continue-no-discovery', goal: boundaryGoal, disclosed: ['repository'], maxCalls: 0, expected: 'continue', evidence: [
    boundaryPatchReport,
    'The patch and regression test are saved locally in src/cart.ts and tests/cart.test.ts.',
    'Execution stopped after saving the fix. The targeted regression and full suite have NOT been run after the change; the earlier failing run is the only test result available.',
    'The test runner and dependencies are installed, and the terminal tool is available. No user information or permission is missing.',
  ].join('\n') },
];
const config = JSON.parse(await readFile(process.env.PROMPT_EVAL_CONFIG_PATH ?? join(homedir(), '.pinpawo/config.json'), 'utf8'));
const profileId = process.env.PROMPT_EVAL_PROFILE_ID ?? config.models.defaultProfileId;
const subject = createDecisionEvalModel({ profileId, role: 'subject' });
const repeats = Number(process.env.DETAILS_EVAL_REPEATS ?? 1);
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('DETAILS_EVAL_REPEATS must be a positive integer.');
const selectedNames = process.env.EVAL_CASES?.split(',').filter(Boolean) ?? [];
if (selectedNames.some((name) => !scenarios.some((scenario) => scenario.name === name))) throw new Error('Unknown EVAL_CASES entry.');
const selected = scenarios.filter(({ name }) => !selectedNames.length || selectedNames.includes(name));
const results = [];
const catalog = createCapabilityCatalog({ registry });
for (const scenario of selected) for (let repeat = 1; repeat <= repeats; repeat++) {
  // Fresh runner per case; routing metadata is built without a model call.
  const supervisor = createRunSupervisorAgent({ model: subject.model });
  const trace = createSupervisorDetailsDiagnostics();
  const disclosure = { ...createCapabilityDisclosureState({ catalog }), disclosedCapabilityNames: scenario.disclosed };
  const input: RunSupervisorInput = { ...supervisorFixture({ catalog, runId: scenario.name, goal: scenario.goal,
    task: scenario.evidence ? scenario.goal : undefined, capability: 'repository', evidence: scenario.evidence }),
    capabilityDisclosure: disclosure };
  let decision: SupervisorDecision | undefined; let error;
  try { decision = readSupervisorDecision(await supervisor.invoke(input, { callbacks: trace.callbacks })); }
  catch (caught) { error = { name: caught instanceof Error ? caught.name : 'UnknownError' }; }
  const diagnostics = trace.read();
  const behaviorPassed = scenario.expected === 'plan'
    ? decision?.name === 'submit_plan' && scenario.required!.every((name) => decision.args.tasks.some((task) => task.capability === name))
    : scenario.expected === 'reply' ? decision?.name === undefined && Boolean(decision?.reply?.trim())
    : decision?.name === 'review_current' && decision.args.completed === (scenario.expected === 'accept')
      && (scenario.expected === 'accept' ? Boolean(decision.args.reply?.trim()) : !decision.args.reply);
  const disclosureBudgetPassed = (scenario.name !== 'entry-requested-details' || diagnostics.detailCalls === 1) && diagnostics.detailCalls <= scenario.maxCalls && diagnostics.repeatedQueries === 0;
  const result = { case: scenario.name, mode: input.mode, repeat, passed: !error && behaviorPassed && disclosureBudgetPassed,
    behaviorPassed, disclosureBudgetPassed, maxDetailCalls: scenario.maxCalls,
    decision: decision ? Object.fromEntries(Object.entries(decision).filter(([key]) => key !== 'capabilityDisclosure')) : null,
    error, diagnostics };
  results.push(result);
  console.log(JSON.stringify(result));
}
const path = resolve(process.env.DETAILS_EVAL_REPORT_PATH ?? join(tmpdir(), `supervisor-details-${profileId}.json`));
await writeFile(path, JSON.stringify({ model: subject.metadata, repeats, results }, null, 2) + '\n');
console.log(`Passed ${results.filter(({ passed }) => passed).length}/${results.length}; report: ${path}`);
if (results.some(({ passed }) => !passed)) process.exitCode = 1;
