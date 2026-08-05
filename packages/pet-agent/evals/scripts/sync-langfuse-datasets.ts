import { LangfuseClient } from '@langfuse/client';
import { agentEvalDatasets } from '../datasets/index.ts';
import { AgentEvalDataset } from '../datasets/types.ts';
import {
  createLangfuseClient,
  resolveLangfuseConfig,
} from './langfuse-api.ts';

async function ensureDataset(client: LangfuseClient, dataset: AgentEvalDataset<unknown, unknown>) {
  const list = await client.api.datasets.list();
  const exists = list.data.some((item) => item.name === dataset.name);
  if (exists) {
    console.log(`Dataset exists: ${dataset.name}`);
    return;
  }

  await client.api.datasets.create({
    name: dataset.name,
    description: dataset.description,
    metadata: dataset.metadata,
  });
  console.log(`Created dataset: ${dataset.name}`);
}

async function syncDataset(client: LangfuseClient, dataset: AgentEvalDataset<unknown, unknown>) {
  await ensureDataset(client, dataset);

  for (const testCase of dataset.cases) {
    await client.dataset.createItem({
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
    });
    console.log(`  upserted ${testCase.id}`);
  }

  console.log(`Synced ${dataset.cases.length} items to ${dataset.name}.`);
}

async function main() {
  const config = resolveLangfuseConfig();
  const client = createLangfuseClient(config);
  console.log(`Syncing Langfuse datasets to ${config.baseUrl}`);
  try {
    for (const dataset of agentEvalDatasets) {
      await syncDataset(client, dataset);
    }
  } finally {
    await client.shutdown();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
