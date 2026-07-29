import { HumanMessage } from '@langchain/core/messages';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import type { PromptEvalReport } from '../prompt-eval-report.ts';
import {
  assertPromptEvalMatrixPricing,
  createPromptEvalMatrixManifest,
  type PromptEvalMatrixChild,
  type PromptEvalModalityResult,
} from '../prompt-eval-matrix.ts';
import {
  createPromptEvalUsageCollector,
  estimatePromptEvalCost,
} from '../prompt-eval-usage.ts';
import { createDecisionEvalModel } from './decision-eval-model.ts';
import {
  readPromptEvalRepeats,
  selectPromptEvalScenarios,
  splitList,
} from './run-decision-stability.eval.ts';

const DEFAULT_MAX_RUNS = 500;

function readPositiveNumber(
  name: string,
  value: string | undefined,
  fallback: number,
) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be greater than zero.`);
  }
  return parsed;
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function redImageDataUrl() {
  const width = 64;
  const height = 64;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    const offset = row * (1 + width * 3);
    scanlines[offset] = 0;
    for (let column = 0; column < width; column += 1) {
      const pixel = offset + 1 + column * 3;
      scanlines[pixel] = 255;
    }
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (typeof block === 'string') return block;
    if (
      typeof block === 'object'
      && block !== null
      && 'text' in block
      && typeof block.text === 'string'
    ) {
      return block.text;
    }
    return '';
  }).join(' ');
}

async function runImageUnderstanding(
  subject: ReturnType<typeof createDecisionEvalModel>,
): Promise<PromptEvalModalityResult> {
  if (!subject.metadata.inputModalities.includes('image')) {
    return {
      status: 'skipped',
      modality: 'image',
      reason: 'unsupported-modality',
    };
  }
  const started = performance.now();
  const usageCollector = createPromptEvalUsageCollector();
  let output = '';
  try {
    const response = await subject.model.invoke([
      new HumanMessage({
        content: [
          {
            type: 'text',
            text: 'Name the single pixel color in the attached image. '
              + 'Reply with exactly one uppercase English color word.',
          },
          {
            type: 'image_url',
            image_url: { url: redImageDataUrl() },
          },
        ],
      }),
    ], {
      callbacks: [usageCollector.callback],
      runName: 'prompt-eval-matrix-image-understanding',
      metadata: {
        promptEvalModelRole: 'subject',
        modelProfileId: subject.metadata.profileId,
        modelProfileFingerprint: subject.metadata.fingerprint,
        promptEvalModality: 'image',
      },
    });
    output = messageText(response.content).trim();
    const usage = usageCollector.read();
    const passed = /^RED[.!]?$/i.test(output);
    return {
      status: passed ? 'passed' : 'failed',
      modality: 'image',
      durationMs: Math.round(performance.now() - started),
      output: output.slice(0, 500),
      error: passed ? null : 'expected the dominant color RED',
      usage,
      estimatedCostUsd: estimatePromptEvalCost(usage, subject.pricing),
    };
  } catch (error) {
    const usage = usageCollector.read();
    return {
      status: 'failed',
      modality: 'image',
      durationMs: Math.round(performance.now() - started),
      output: output.slice(0, 500),
      error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      usage,
      estimatedCostUsd: estimatePromptEvalCost(usage, subject.pricing),
    };
  }
}

function readChildReport(path: string): PromptEvalReport {
  const report = JSON.parse(readFileSync(path, 'utf8')) as PromptEvalReport;
  if (report.reportVersion !== 4 || report.kind !== 'prompt-stability') {
    throw new Error(`Child report ${path} is not a prompt stability V4 report.`);
  }
  return report;
}

function runChild(profileId: string, judgeProfileId: string, reportPath: string) {
  const packageRoot = resolve(import.meta.dirname, '../..');
  const result = spawnSync(
    'npm',
    ['run', 'eval:prompt-stability'],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        PROMPT_EVAL_MODEL_PROFILE_ID: profileId,
        PROMPT_EVAL_JUDGE_PROFILE_ID: judgeProfileId,
        PROMPT_EVAL_REPORT_PATH: reportPath,
      },
      encoding: 'utf8',
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function main() {
  const subjectProfileIds = splitList(
    process.env.PROMPT_EVAL_MODEL_PROFILE_IDS,
  );
  const judgeProfileId = process.env.PROMPT_EVAL_JUDGE_PROFILE_ID?.trim();
  if (subjectProfileIds.length === 0) {
    throw new Error('PROMPT_EVAL_MODEL_PROFILE_IDS is required.');
  }
  if (new Set(subjectProfileIds).size !== subjectProfileIds.length) {
    throw new Error('PROMPT_EVAL_MODEL_PROFILE_IDS contains duplicates.');
  }
  if (!judgeProfileId) {
    throw new Error('PROMPT_EVAL_JUDGE_PROFILE_ID is required.');
  }

  const judge = createDecisionEvalModel({
    profileId: judgeProfileId,
    role: 'judge',
  });
  const subjects = subjectProfileIds.map((profileId) => createDecisionEvalModel({
    profileId,
    role: 'subject',
  }));
  for (const subject of subjects) {
    if (subject.metadata.fingerprint === judge.metadata.fingerprint) {
      throw new Error(
        `Subject "${subject.metadata.profileId}" resolves to the fixed judge fingerprint.`,
      );
    }
  }

  const repeats = readPromptEvalRepeats();
  const { scenarios } = selectPromptEvalScenarios();
  const imageRuns = subjects.filter(
    ({ metadata }) => metadata.inputModalities.includes('image'),
  ).length;
  const plannedRuns = scenarios.length * repeats * subjects.length + imageRuns;
  const maxRuns = readPositiveNumber(
    'PROMPT_EVAL_MATRIX_MAX_RUNS',
    process.env.PROMPT_EVAL_MATRIX_MAX_RUNS,
    DEFAULT_MAX_RUNS,
  );
  if (plannedRuns > maxRuns) {
    throw new Error(
      `Matrix plans ${plannedRuns.toString()} evaluation runs, exceeding `
      + `PROMPT_EVAL_MATRIX_MAX_RUNS=${maxRuns.toString()}.`,
    );
  }
  const maxEstimatedCostUsd = process.env.PROMPT_EVAL_MATRIX_MAX_ESTIMATED_COST_USD
    ? readPositiveNumber(
        'PROMPT_EVAL_MATRIX_MAX_ESTIMATED_COST_USD',
        process.env.PROMPT_EVAL_MATRIX_MAX_ESTIMATED_COST_USD,
        Number.POSITIVE_INFINITY,
      )
    : null;
  if (maxEstimatedCostUsd !== null) {
    assertPromptEvalMatrixPricing({
      judge: {
        profileId: judge.metadata.profileId,
        pricing: judge.pricing,
      },
      subjects: subjects.map((subject) => ({
        profileId: subject.metadata.profileId,
        pricing: subject.pricing,
      })),
    });
  }
  const matrixRoot = resolve(
    process.env.PROMPT_EVAL_MATRIX_DIR
      ?? resolve(
        '.eval-results',
        `prompt-matrix-${Date.now().toString()}`,
      ),
  );
  mkdirSync(matrixRoot, { recursive: true });

  console.log('Prompt eval model matrix');
  console.log(`Subjects: ${subjectProfileIds.join(', ')}`);
  console.log(`Judge: ${judge.label}`);
  console.log(`Planned evaluation runs: ${plannedRuns.toString()}/${maxRuns.toString()}`);
  console.log('Concurrency: sequential');

  const children: PromptEvalMatrixChild[] = [];
  let childFailure = false;
  for (const subject of subjects) {
    const reportPath = resolve(
      matrixRoot,
      `${subject.metadata.profileId}.prompt-stability.json`,
    );
    console.log(`\n=== Subject ${subject.label} ===`);
    const status = runChild(
      subject.metadata.profileId,
      judge.metadata.profileId,
      reportPath,
    );
    const promptReport = readChildReport(reportPath);
    const imageUnderstanding = await runImageUnderstanding(subject);
    children.push({
      subject: subject.metadata,
      reportPath,
      promptReport,
      imageUnderstanding,
    });
    childFailure ||= status !== 0 || imageUnderstanding.status === 'failed';

    if (maxEstimatedCostUsd !== null) {
      const knownCost = children.reduce((sum, child) => {
        const promptCost = child.promptReport.totals.estimatedCostUsd;
        const judgeCost = child.promptReport.totals.evaluationUsageRuns === 0
          ? 0
          : child.promptReport.totals.evaluationEstimatedCostUsd;
        const imageCost = child.imageUnderstanding.status === 'skipped'
          ? 0
          : child.imageUnderstanding.estimatedCostUsd;
        if (promptCost === null || judgeCost === null || imageCost === null) {
          throw new Error(
            'Matrix cost budget enforcement requires complete provider usage '
            + 'and estimated-cost coverage for every completed run.',
          );
        }
        return sum + promptCost + judgeCost + imageCost;
      }, 0);
      if (knownCost > maxEstimatedCostUsd) {
        throw new Error(
          `Matrix estimated cost ${knownCost.toFixed(6)} exceeded budget `
          + `${maxEstimatedCostUsd.toFixed(6)}; remaining subjects were not run.`,
        );
      }
    }
  }

  const manifest = createPromptEvalMatrixManifest({
    children,
    judge: judge.metadata,
    maxRuns,
    plannedRuns,
    maxEstimatedCostUsd,
  });
  const manifestPath = resolve(
    process.env.PROMPT_EVAL_MATRIX_REPORT_PATH
      ?? resolve(matrixRoot, 'matrix.json'),
  );
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log('\nMatrix summary:');
  for (const child of manifest.children) {
    console.log(
      `- ${child.subject.profileId}: pass=${(
        child.passRate * 100
      ).toFixed(1)}% meanMs=${child.meanDurationMs.toString()} `
      + `image=${child.imageUnderstanding.status}`,
    );
  }
  console.log(`Overall pass rate: ${(manifest.totals.passRate * 100).toFixed(1)}%`);
  console.log(`Manifest: ${manifestPath}`);
  if (childFailure) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  });
}
