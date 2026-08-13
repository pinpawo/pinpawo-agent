import type { StructuredOutputMethod } from '../../src/utils/structuredOutput.ts';
import {
  getDecisionEvalScenarios,
  type DecisionEvalTarget,
} from '../decision-eval-scenarios.ts';
import { measureDecisionPrompt } from '../prompt-preview.ts';

const TARGETS: DecisionEvalTarget[] = ['goal_creation'];

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readTarget(): DecisionEvalTarget | undefined {
  const value = process.argv[2];
  if (value?.startsWith('--')) return undefined;
  if (!value || value === 'all') return undefined;
  if (TARGETS.includes(value as DecisionEvalTarget)) return value as DecisionEvalTarget;
  throw new Error(`Unknown decision target: ${value}. Use ${TARGETS.join(', ')}, or all.`);
}

function readMethod(): StructuredOutputMethod | undefined {
  const value = readOption('--method');
  if (!value) return undefined;
  if (value === 'functionCalling' || value === 'jsonMode' || value === 'jsonSchema') return value;
  throw new Error(`Unknown structured output method: ${value}.`);
}

function main() {
  const target = readTarget();
  const caseFilter = readOption('--case');
  const method = readMethod();
  const scenarios = getDecisionEvalScenarios(target).filter((scenario) => !caseFilter
    || scenario.caseId === caseFilter
    || scenario.caseName === caseFilter);
  if (scenarios.length === 0) {
    throw new Error(`No prompt cases matched${caseFilter ? ` --case ${caseFilter}` : ''}.`);
  }

  for (const scenario of scenarios) {
    const prompt = scenario.render(method);
    const metrics = measureDecisionPrompt(prompt);
    console.log(`\n=== ${scenario.target} / ${scenario.caseName} ===`);
    console.log(`Dataset: ${scenario.datasetName}`);
    console.log(`Case ID: ${scenario.caseId}`);
    console.log(`Expected: ${scenario.expectedSummary}`);
    console.log(
      `Size: system=${metrics.systemChars} chars/${metrics.systemLines} lines, `
      + `input=${metrics.inputChars} chars/${metrics.inputLines} lines, `
      + `total≈${metrics.approximateTokens} tokens`,
    );
    console.log(`Shared prefix: ${metrics.sharedPrefixPercent}% of system prompt`);
    console.log('\n--- SYSTEM MESSAGE ---');
    console.log(prompt.system);
    console.log('\n--- STRUCTURED CONTEXT MESSAGE ---');
    console.log(prompt.input);
    if (prompt.conversationMessages) {
      console.log('\n--- CANONICAL MAIN MESSAGES ---');
      for (const message of prompt.conversationMessages) {
        console.log(`[${message._getType()}]`);
        console.log(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
      }
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
}
