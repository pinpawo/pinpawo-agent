import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { assertArtifactRef, createToolDeliverables, parseArtifactUri, type ArtifactRef } from '@pinpawo/agent-contracts';
import { defineToolkit, readToolExecutionContext, ReviewPolicies, type AgentToolkit } from '@pinpawo/pet-agent';
import { z } from 'zod';
import { MAX_ARTIFACT_BYTES, type ArtifactSourceReader, type ArtifactStore } from './types';

export const ARTIFACTS_TOOLKIT_NAME = 'artifacts';

function within(root: string, path: string) {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

function context(runtime: ToolRuntime) {
  const result = readToolExecutionContext(runtime);
  if (!result.agentSessionId) throw new Error('Artifact tools require an Agent session.');
  runtime.signal?.throwIfAborted();
  return { threadId: result.agentSessionId, workdir: result.workdir };
}

function bounded(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  let size = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > MAX_ARTIFACT_BYTES) throw new Error('Artifact exceeds the 100 MB file limit.');
      controller.enqueue(chunk);
    },
  }), { signal });
}

function requireFileName(name: string) {
  if (!name || name === '.' || name === '..' || /[/\\\u0000]/.test(name)) {
    throw new TypeError('Artifact name must be a single file name.');
  }
}

async function download(input: {
  body: ReadableStream<Uint8Array>; ref: ArtifactRef; target: string;
  temporaryRoot: string; sessionDirectory: string; signal?: AbortSignal;
}) {
  const managed = within(input.temporaryRoot, input.target);
  if (managed && !within(input.sessionDirectory, input.target)) {
    await input.body.cancel();
    throw new Error('A temporary artifact path must belong to the current Agent session.');
  }
  const reader = bounded(input.body, input.signal).getReader();
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryPath: string | undefined;
  try {
    const directory = dirname(input.target);
    if (managed) {
      await mkdir(input.temporaryRoot, { recursive: true, mode: 0o700 });
      const actualRoot = await realpath(input.temporaryRoot);
      let current = actualRoot;
      for (const segment of relative(input.temporaryRoot, directory).split(sep).filter(Boolean)) {
        current = resolve(current, segment);
        try { await mkdir(current, { mode: 0o700 }); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        if (!(await lstat(current)).isDirectory() || await realpath(current) !== current) {
          throw new Error('A temporary artifact path resolves outside its session directory.');
        }
      }
    } else await mkdir(directory, { recursive: true, mode: 0o700 });
    input.signal?.throwIfAborted();
    temporaryPath = join(directory, `.artifact-download-${randomUUID()}.tmp`);
    file = await open(temporaryPath, 'wx', 0o600);
    let size = 0;
    const hash = createHash('sha256');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      hash.update(value);
      await file.writeFile(value);
    }
    if (size !== input.ref.size || hash.digest('hex') !== input.ref.sha256) {
      throw new Error('Downloaded artifact does not match its stored size and hash.');
    }
    await file.close();
    file = undefined;
    await rename(temporaryPath, input.target);
    temporaryPath = undefined;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    await file?.close().catch(() => undefined);
    if (temporaryPath) await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** The Host supplies storage and file access; the Toolkit owns calls and policy. */
export function createArtifactsToolkit(options: {
  store: ArtifactStore;
  sourceReader: ArtifactSourceReader;
  /** Internal Host/test selection, not a user or model parameter. */
  tempRoot?: string;
}): AgentToolkit {
  const temporaryRoot = resolve(options.tempRoot ?? join(tmpdir(), `pinpawo-artifacts-${randomUUID()}`));
  const sessionDirectory = (threadId: string) => join(temporaryRoot, Buffer.from(threadId).toString('base64url'));
  const publish = tool(async ({ path, title }: { path: string; title?: string }, runtime: ToolRuntime) => {
    const { threadId, workdir } = context(runtime);
    const source = await options.sourceReader({ path, workdir });
    const body = bounded(source.body, runtime.signal);
    let ref: ArtifactRef;
    try {
      ref = await options.store.put({
        threadId, name: source.name, mimeType: source.mimeType,
        ...(title !== undefined ? { title } : {}), body,
      });
    } catch (error) {
      await body.cancel(error).catch(() => undefined);
      throw error;
    }
    assertArtifactRef(ref);
    const label = (ref.title ?? ref.name).replace(/[\\[\]]/g, '\\$&');
    return [
      `${JSON.stringify(ref)}\n\n[${label}](${ref.uri})`,
      createToolDeliverables([{ uri: ref.uri, title: ref.title ?? ref.name }]),
    ];
  }, {
    name: 'publish_artifact', description: 'Publish a local file snapshot and return its stable artifact reference and Markdown link.',
    responseFormat: 'content_and_artifact',
    schema: z.object({ path: z.string().min(1), title: z.string().optional() }).strict(),
  });
  const list = tool(async (_input: Record<string, never>, runtime: ToolRuntime) => {
    const { threadId } = context(runtime);
    const refs = await options.store.list(threadId);
    refs.forEach(assertArtifactRef);
    return JSON.stringify(refs);
  }, {
    name: 'list_artifacts', description: 'List files published by the current Agent session only.', schema: z.object({}).strict(),
  });
  const downloadTool = tool(async ({ uri, path }: { uri: string; path?: string }, runtime: ToolRuntime) => {
    const { threadId, workdir } = context(runtime);
    parseArtifactUri(uri);
    const fetched = await options.store.fetch(uri);
    let body = 'body' in fetched ? fetched.body : undefined;
    try {
      assertArtifactRef(fetched.ref);
      if (fetched.ref.uri !== uri) throw new Error('Artifact store returned a different reference.');
      requireFileName(fetched.ref.name);
      const directory = sessionDirectory(threadId);
      const target = path === undefined
        ? join(directory, randomUUID(), fetched.ref.name)
        : isAbsolute(path) ? resolve(path) : workdir ? resolve(workdir, path)
          : (() => { throw new Error('A relative download path requires a workdir.'); })();
      if (!body && 'url' in fetched) {
        const response = await fetch(fetched.url, { signal: runtime.signal });
        body = response.body ?? undefined;
        if (!response.ok || !body) throw new Error(`Artifact download failed with HTTP ${response.status}.`);
      }
      if (!body) throw new Error('Artifact store returned no downloadable body.');
      await download({ body, ref: fetched.ref, target, temporaryRoot, sessionDirectory: directory, signal: runtime.signal });
      return JSON.stringify({ uri, path: target });
    } catch (error) {
      await body?.cancel(error).catch(() => undefined);
      throw error;
    }
  }, {
    name: 'download_artifact', description: 'Download a received artifact reference. Omit path to use the current session temporary directory; otherwise write to the selected path.',
    schema: z.object({ uri: z.string().min(1), path: z.string().min(1).optional() }).strict(),
  });
  const writeReview = ReviewPolicies.required({ authorization: 'exact' });
  return defineToolkit({
    name: ARTIFACTS_TOOLKIT_NAME,
    description: 'Publish, list and download explicit session file snapshots.',
    instructions: 'Publish files that the requester needs as deliverables with publish_artifact. Workdir and temporary files alone are not published. Share the stable artifact:// reference, never a temporary signed URL. Download a received reference only when its file content is needed, then read the returned path with file tools. list_artifacts lists only this session.',
    tools: [
      { tool: publish, operation: { title: 'Publish artifact' } },
      { tool: list, operation: { title: 'List session artifacts' } },
      { tool: downloadTool, operation: { title: 'Download artifact' }, review: {
        ...writeReview,
        request: ctx => {
          const path = ctx.input && typeof ctx.input === 'object' ? Reflect.get(ctx.input, 'path') : undefined;
          return path === undefined || (typeof path === 'string' && isAbsolute(path) && within(temporaryRoot, resolve(path)))
            ? null : writeReview.request(ctx);
        },
      } },
    ],
  });
}
