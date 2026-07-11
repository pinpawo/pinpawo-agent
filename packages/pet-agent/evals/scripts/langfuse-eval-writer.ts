import { randomUUID } from 'node:crypto';
import { AgentEvalCase } from '../datasets/types.ts';
import { LangfuseConfig, langfuseFetch } from './langfuse-api.ts';

export type LangfuseEvalScore = {
  key: string;
  score: number;
  comment?: string;
};

export async function writeLangfuseEvalResult(params: {
  config: LangfuseConfig;
  datasetName: string;
  runName: string;
  traceName: string;
  testCase: AgentEvalCase<unknown, unknown>;
  output: Record<string, unknown>;
  scores: LangfuseEvalScore[];
  durationMs: number;
  error?: string;
}) {
  const traceId = `${params.runName}.${params.testCase.name}.${randomUUID()}`
    .replace(/[^a-zA-Z0-9_.:-]/g, '-')
    .slice(0, 200);
  await langfuseFetch(params.config, '/traces', {
    method: 'POST',
    body: JSON.stringify({
      id: traceId,
      name: params.traceName,
      input: params.testCase.input,
      output: params.error ? { ...params.output, error: params.error } : params.output,
      metadata: {
        runName: params.runName,
        datasetName: params.datasetName,
        datasetItemId: params.testCase.id,
        caseName: params.testCase.name,
        tags: params.testCase.tags,
        durationMs: params.durationMs,
      },
    }),
  });
  for (const score of params.scores) {
    await langfuseFetch(params.config, '/scores', {
      method: 'POST',
      body: JSON.stringify({
        traceId,
        name: score.key,
        value: score.score,
        comment: score.comment,
      }),
    });
  }
  await langfuseFetch(params.config, '/dataset-run-items', {
    method: 'POST',
    body: JSON.stringify({
      runName: params.runName,
      datasetItemId: params.testCase.id,
      traceId,
    }),
  });
}
