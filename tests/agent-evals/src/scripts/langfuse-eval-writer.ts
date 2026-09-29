import { startActiveObservation } from '@langfuse/tracing';
import { AgentEvalCase } from '../datasets/types.ts';
import { LangfuseV4Runtime } from './langfuse-v4-runtime.ts';

export type LangfuseEvalScore = {
  key: string;
  score: number;
  comment?: string;
};

export async function writeLangfuseEvalResult(params: {
  runtime: LangfuseV4Runtime;
  datasetName: string;
  runName: string;
  traceName: string;
  testCase: AgentEvalCase<unknown, unknown>;
  output: Record<string, unknown>;
  scores: LangfuseEvalScore[];
  durationMs: number;
  error?: string;
  metadata?: Record<string, unknown>;
}) {
  const [datasetId, experimentId] = await Promise.all([
    params.runtime.datasetId(params.datasetName),
    params.runtime.experimentId(params.datasetName, params.runName),
  ]);
  const output = params.error ? { ...params.output, error: params.error } : params.output;
  const metadata = {
    ...params.metadata,
    runName: params.runName,
    datasetName: params.datasetName,
    datasetItemId: params.testCase.id,
    caseName: params.testCase.name,
    tags: params.testCase.tags,
    durationMs: params.durationMs,
  };

  const { observationId, traceId } = await startActiveObservation(params.traceName, async (span) => {
    span.otelSpan.setAttributes({
      'langfuse.experiment.id': experimentId,
      'langfuse.experiment.name': params.runName,
      'langfuse.experiment.description': params.traceName,
      'langfuse.experiment.metadata': JSON.stringify({
        datasetName: params.datasetName,
        ...params.metadata,
      }),
      'langfuse.experiment.dataset.id': datasetId,
      'langfuse.experiment.item.id': params.testCase.id,
      'langfuse.experiment.item.expected_output': JSON.stringify(params.testCase.expected),
      'langfuse.experiment.item.metadata': JSON.stringify({
        name: params.testCase.name,
        suite: params.testCase.suite,
        tags: params.testCase.tags,
        ...params.testCase.metadata,
      }),
      'langfuse.experiment.item.root_observation_id': span.id,
    });
    span.update({
      input: params.testCase.input,
      output,
      metadata,
      ...(params.error ? { level: 'ERROR' as const, statusMessage: params.error } : {}),
    });
    return { observationId: span.id, traceId: span.traceId };
  });

  for (const score of params.scores) {
    params.runtime.client.score.create({
      traceId,
      observationId,
      name: score.key,
      value: score.score,
      comment: score.comment,
    });
  }
  await params.runtime.client.flush();
}
