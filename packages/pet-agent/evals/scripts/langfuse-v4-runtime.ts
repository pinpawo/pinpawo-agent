import { createHash } from 'node:crypto';
import { LangfuseClient } from '@langfuse/client';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseConfig, createLangfuseClient } from './langfuse-api.ts';

export type LangfuseV4Runtime = {
  client: LangfuseClient;
  datasetId(datasetName: string): Promise<string>;
  experimentId(datasetName: string, runName: string): string;
  shutdown(): Promise<void>;
};

export function createLangfuseV4Runtime(config: LangfuseConfig): LangfuseV4Runtime {
  const client = createLangfuseClient(config);
  const sdk = new NodeSDK({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        exportMode: 'immediate',
      }),
    ],
  });
  sdk.start();

  const datasetIds = new Map<string, Promise<string>>();

  return {
    client,
    datasetId(datasetName) {
      const existing = datasetIds.get(datasetName);
      if (existing) return existing;

      const request = client.api.datasets.get(datasetName).then((dataset) => dataset.id);
      datasetIds.set(datasetName, request);
      return request;
    },
    experimentId(datasetName, runName) {
      return createHash('sha256')
        .update(`${datasetName}:${runName}`)
        .digest('hex')
        .slice(0, 16);
    },
    async shutdown() {
      await client.shutdown();
      await sdk.shutdown();
    },
  };
}
