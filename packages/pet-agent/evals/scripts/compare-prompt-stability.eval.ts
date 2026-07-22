import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  comparePromptEvalReports,
  PROMPT_EVAL_REPORT_VERSION,
  type PromptEvalReport,
} from '../prompt-eval-report.ts';

function readReport(path: string): PromptEvalReport {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<PromptEvalReport>;
  if (value.reportVersion !== PROMPT_EVAL_REPORT_VERSION || value.kind !== 'prompt-stability') {
    throw new Error(`Unsupported prompt eval report: ${path}`);
  }
  if (!value.revision || !value.model || !Array.isArray(value.summaries)) {
    throw new Error(`Incomplete prompt eval report: ${path}`);
  }
  return value as PromptEvalReport;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signed(value: number, digits = 0): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function main() {
  const [baselinePath, candidatePath] = process.argv.slice(2);
  if (!baselinePath || !candidatePath) {
    throw new Error('Usage: npm run eval:prompt-compare -- <baseline.json> <candidate.json>');
  }
  const baseline = readReport(resolve(baselinePath));
  const candidate = readReport(resolve(candidatePath));
  const comparison = comparePromptEvalReports(baseline, candidate);

  console.log('Prompt eval comparison');
  console.log(`Baseline: ${baseline.revision.commit}${baseline.revision.dirty ? ' (dirty)' : ''}`);
  console.log(`Candidate: ${candidate.revision.commit}${candidate.revision.dirty ? ' (dirty)' : ''}`);
  console.log(`Harness: ${candidate.revision.harnessCommit}`);
  console.log(`Model: ${candidate.model.provider}/${candidate.model.model}`);
  console.log(`Comparable settings: ${comparison.compatible ? 'yes' : 'no'}`);
  if (comparison.compatibilityNotes.length > 0) {
    console.log(`Notes: ${comparison.compatibilityNotes.join('; ')}`);
  }
  console.log('');
  for (const row of comparison.rows) {
    console.log(
      `- ${row.target}/${row.caseId}: `
      + `pass ${formatPercent(row.baselinePassRate)} -> ${formatPercent(row.candidatePassRate)} `
      + `(${signed(row.passRateDelta * 100, 1)}pp); `
      + `latency ${signed(row.meanDurationDeltaMs)}ms; `
      + `tokens ${row.meanTokensDelta === null ? 'n/a' : signed(row.meanTokensDelta, 1)}`,
    );
  }
  if (comparison.baselineOnlyCases.length > 0) {
    console.log(`\nBaseline-only cases: ${comparison.baselineOnlyCases.join(', ')}`);
  }
  if (comparison.candidateOnlyCases.length > 0) {
    console.log(`\nCandidate-only cases: ${comparison.candidateOnlyCases.join(', ')}`);
  }
  if (!comparison.compatible) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
}
