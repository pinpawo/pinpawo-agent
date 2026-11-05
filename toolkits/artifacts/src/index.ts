import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command, ReducedValue, StateSchema } from '@langchain/langgraph';
import { isDeliverable, parseArtifactUri, parseDeliverables, type Deliverable } from '@pinpawo/agent-contracts';
import {
  defineToolkit,
  readToolExecutionContext,
  ReviewPolicies,
  type AgentToolkit,
} from '@pinpawo/pet-agent';
import { z } from 'zod';
import { z as stateZod } from 'zod/v4';
import { limitArtifactBody } from './body';
import type { ArtifactDownloadWriter, ArtifactSourceReader, ArtifactStore } from './ports';

export { MAX_ARTIFACT_BYTES, limitArtifactBody } from './body';
export type { ArtifactStore, ArtifactSourceReader, ArtifactDownloadWriter } from './ports';
export const ARTIFACTS_TOOLKIT_NAME = 'artifacts';

const artifactsStateSchema = new StateSchema({
  deliverables: new ReducedValue<Deliverable[], Deliverable[]>(
    stateZod.array(stateZod.custom<Deliverable>(isDeliverable)).default([]) as never,
    { reducer: (current, next) => [...current, ...next]
      .filter((reference, index, references) => references.findIndex(other => other.uri === reference.uri) === index) },
  ),
});

export type ArtifactsToolkitDependencies = {
  store: ArtifactStore;
  sourceReader: ArtifactSourceReader;
  downloadWriter: ArtifactDownloadWriter;
};

function executionContext(config: unknown) {
  const { agentSessionId, workdir } = readToolExecutionContext(config);
  if (!agentSessionId) throw new Error('Artifact tools require an Agent session (threadId).');
  return { threadId: agentSessionId, workdir };
}

function markdownLabel(label: string) {
  return label.replace(/[\r\n]+/g, ' ').replace(/[\\\[\]]/g, '\\$&');
}

export function createArtifactsToolkit(deps: ArtifactsToolkitDependencies): AgentToolkit {
  const publish = tool(async ({ path, title }, config: ToolRuntime) => {
    const { threadId, workdir } = executionContext(config);
    const source = await deps.sourceReader({ path, workdir });
    const ref = await deps.store.put({
      threadId, name: source.name, mimeType: source.mimeType,
      ...(title !== undefined ? { title } : {}), body: limitArtifactBody(source.body, config.signal),
    });
    parseArtifactUri(ref.uri);
    const deliverables = parseDeliverables([{
      uri: ref.uri, ...(ref.title !== undefined ? { title: ref.title } : {}),
    }]);
    return new Command({ update: {
      deliverables,
      messages: [new ToolMessage({
        name: 'publish_artifact', tool_call_id: config.toolCall?.id ?? config.toolCallId,
        content: `${JSON.stringify(ref)}\n[${markdownLabel(ref.title ?? ref.name)}](${ref.uri})`,
        artifact: ref,
      })],
    } });
  }, {
    name: 'publish_artifact',
    description: 'Publish a local file snapshot for delivery and return its stable artifact reference.',
    schema: z.object({
      path: z.string().min(1).refine((path) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(path), 'A local file path is required.'),
      title: z.string().optional(),
    }).strict(),
  });

  const list = tool(async (_input, config) => {
    const { threadId } = executionContext(config);
    return JSON.stringify(await deps.store.list(threadId));
  }, {
    name: 'list_artifacts',
    description: 'List artifacts published by the current Agent session.',
    schema: z.object({}).strict(),
  });

  const download = tool(async ({ uri, path }, config) => {
    const { threadId, workdir } = executionContext(config);
    parseArtifactUri(uri);
    const fetched = await deps.store.fetch(uri);
    let body: ReadableStream<Uint8Array>;
    if ('body' in fetched) {
      body = fetched.body;
    } else {
      const response = await fetch(fetched.url, { signal: config.signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Artifact download failed (${response.status}).`);
      }
      body = response.body;
    }
    const destination = await deps.downloadWriter({
      threadId, workdir, ref: fetched.ref,
      ...(path !== undefined ? { path } : {}), body: limitArtifactBody(body, config.signal), signal: config.signal,
    });
    return JSON.stringify({ path: destination, ref: fetched.ref });
  }, {
    name: 'download_artifact',
    description: 'Download a stable artifact reference to a local file without review. Omit path to use this session’s temporary directory. Read the returned path with file tools when needed.',
    schema: z.object({ uri: z.string().min(1), path: z.string().min(1).optional() }).strict(),
  });

  return defineToolkit({
    name: ARTIFACTS_TOOLKIT_NAME,
    description: 'Explicitly publish local file snapshots, list this session’s artifacts, and download shared references.',
    stateSchema: artifactsStateSchema,
    tools: [
      { tool: publish, review: ReviewPolicies.never() },
      { tool: list, review: ReviewPolicies.never() },
      { tool: download, review: ReviewPolicies.never() },
    ],
    instructions: [
      'When you create a file or a tool returns a local file path, decide whether the task requires handing that file to the requester. Publish the files selected for delivery with publish_artifact.',
      'Publishing saves a file snapshot and returns a stable artifact:// reference. Use the returned references when handing over files.',
      'Use list_artifacts to find this session’s published snapshots. Shared artifact:// references from other sessions can be downloaded when needed.',
      'Download a reference when you need its file, then read the returned local path with existing file tools. The single-file publication limit is 100 MB.',
      'Use links returned by other tools according to their source contract.',
    ].join('\n'),
  });
}
