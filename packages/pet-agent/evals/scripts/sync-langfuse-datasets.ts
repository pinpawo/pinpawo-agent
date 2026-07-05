import { agentEvalDatasets } from '../datasets/index.ts';
import { AgentEvalDataset } from '../datasets/types.ts';
import {
  LangfuseConfig,
  langfuseFetch,
  resolveLangfuseConfig,
} from './langfuse-api.ts';

async function ensureDataset(config: LangfuseConfig, dataset: AgentEvalDataset<unknown, unknown>) {
  const list = await langfuseFetch<{ data?: Array<{ name: string }> }>(config, '/datasets');
  const exists = list.data?.some((item) => item.name === dataset.name) ?? false;
  if (exists) {
    console.log(`Dataset exists: ${dataset.name}`);
    return;
  }

  await langfuseFetch(config, '/datasets', {
    method: 'POST',
    body: JSON.stringify({
      name: dataset.name,
      description: dataset.description,
      metadata: dataset.metadata,
    }),
  });
  console.log(`Created dataset: ${dataset.name}`);
}

async function syncDataset(config: LangfuseConfig, dataset: AgentEvalDataset<unknown, unknown>) {
  await ensureDataset(config, dataset);

  for (const testCase of dataset.cases) {
    await langfuseFetch(config, '/dataset-items', {
      method: 'POST',
      body: JSON.stringify({
        id: testCase.id,
        datasetName: dataset.name,
        input: testCase.input,
        expectedOutput: testCase.expected,
        metadata: {
          name: testCase.name,
          suite: testCase.suite,
          tags: testCase.tags,
          ...testCase.metadata,
        },
      }),
    });
    console.log(`  upserted ${testCase.id}`);
  }

  console.log(`Synced ${dataset.cases.length} items to ${dataset.name}.`);
}

async function main() {
  const config = resolveLangfuseConfig();
  console.log(`Syncing Langfuse datasets to ${config.baseUrl}`);
  for (const dataset of agentEvalDatasets) {
    await syncDataset(config, dataset);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
