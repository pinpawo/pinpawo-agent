import { tool } from '@langchain/core/tools';
import { parseArtifactUri, parseDeliverables } from '@pinpawo/agent-contracts';
import {
  defineToolkit,
  readToolExecutionContext,
  ReviewPolicies,
  type AgentToolkit,
} from '@pinpawo/pet-agent';
import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { limitArtifactBody } from './body';
import type { ArtifactDownloadWriter, ArtifactSourceReader, ArtifactStore } from './ports';

export { MAX_ARTIFACT_BYTES, limitArtifactBody } from './body';
export type { ArtifactStore, ArtifactSourceReader, ArtifactDownloadWriter } from './ports';
export const ARTIFACTS_TOOLKIT_NAME = 'artifacts';

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

function isWithin(root: string, path: string) {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

async function isTemporaryDestination(input: unknown, workdir?: string | null): Promise<boolean> {
  if (!input || typeof input !== 'object' || !('path' in input)
    || typeof input.path !== 'string' || !input.path.trim()) return false;
  const base = workdir ?? process.cwd();
  const target = isAbsolute(input.path) ? input.path : resolve(base, input.path);
  // The writer uses existing parents and renames over the destination entry.
  // Resolve the parent, rather than following a destination symlink it replaces.
  try {
    const [temporaryRoot, realWorkdir, parent] = await Promise.all([
      realpath(tmpdir()), realpath(base), realpath(dirname(target)),
    ]);
    const destination = join(parent, basename(target));
    return isWithin(temporaryRoot, destination)
      && !isWithin(realWorkdir, destination)
      && !isWithin(resolve(base), resolve(target));
  } catch {
    return false;
  }
}

export function createArtifactsToolkit(deps: ArtifactsToolkitDependencies): AgentToolkit {
  const publish = tool(async ({ path, title }, config) => {
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
    return [
      `${JSON.stringify(ref)}\n[${markdownLabel(ref.title ?? ref.name)}](${ref.uri})`,
      { deliverables },
    ];
  }, {
    name: 'publish_artifact',
    description: 'Publish a local file snapshot for delivery. Returns a stable artifact reference and declares it as a deliverable. The source path is local; URLs are not accepted.',
    schema: z.object({
      path: z.string().min(1).refine((path) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(path), 'A local file path is required.'),
      title: z.string().optional(),
    }).strict(),
    responseFormat: 'content_and_artifact',
  });

  const list = tool(async (_input, config) => {
    const { threadId } = executionContext(config);
    return JSON.stringify(await deps.store.list(threadId));
  }, {
    name: 'list_artifacts',
    description: 'List artifacts published by the current Agent session. This does not list other sessions.',
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
    description: 'Download a stable artifact reference to a local file. Omit path to use this session’s temporary directory. Temporary destinations outside the workdir need no review; other destinations require file-write review. Read the returned path with file tools when needed.',
    schema: z.object({ uri: z.string().min(1), path: z.string().min(1).optional() }).strict(),
  });

  const explicitDownloadReview = ReviewPolicies.required({
    authorization: 'exact',
    canAutoApprove: (context) => isTemporaryDestination(context.input, context.workdir),
  });
  return defineToolkit({
    name: ARTIFACTS_TOOLKIT_NAME,
    description: 'Explicitly publish local file snapshots, list this session’s artifacts, and download shared references.',
    tools: [
      { tool: publish, review: ReviewPolicies.never() },
      { tool: list, review: ReviewPolicies.never() },
      { tool: download, review: {
        ...explicitDownloadReview,
        request: async (context) => {
          if (!context.input || typeof context.input !== 'object'
            || !('path' in context.input) || context.input.path === undefined) return null;
          return await isTemporaryDestination(context.input, context.workdir)
            ? null : explicitDownloadReview.request(context);
        },
      } },
    ],
    instructions: [
      'Publish files that the task requires you to deliver with publish_artifact, even when another tool only returned a local path. Only explicitly published files are artifacts.',
      'Publishing copies a snapshot and returns a stable artifact:// reference. Deliver those references; editing the source later does not update an existing artifact.',
      'Use list_artifacts only for this session. You may download a shared artifact:// reference from another session without reading that session’s runtime context.',
      'Download a reference only when you need its file, then read the local path with existing file tools. Files over 100 MB cannot be published.',
      'Existing URLs from other tools keep their source contract. Do not pass a URL to publish_artifact or claim an undeclared link is a structured deliverable.',
    ].join('\n'),
  });
}
