import {
  AIMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { GENERAL_CAPABILITY_NAME } from '../../../types/capability';
import {
  CAPABILITY_ROUTING_MANIFEST_INPUT_PROMPT,
  CAPABILITY_ROUTING_MANIFEST_SYSTEM_PROMPT,
} from '../prompts/templates/capabilityRoutingManifest.prompt';
import { xmlTextBlock } from '../prompts/shared';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';
import { createInvocationContextMessage } from '../../modelContext/invocationContext';

export const CAPABILITY_ROUTING_MANIFEST_COMMIT_TOOL_NAME =
  'commit_capability_routing_manifest';

export type CapabilityRegistryManifest = {
  readonly defaultCapabilityName?: string;
  readonly capabilities: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly toolkits: ReadonlyArray<{
      readonly name: string;
      readonly description: string;
    }>;
  }>;
};

export type CapabilityRoutingManifest = {
  readonly defaultCapabilityName?: string;
  readonly capabilities: ReadonlyArray<{
    readonly name: string;
    readonly purpose: string;
    readonly cues: readonly string[];
    /** Deterministic execution scope; model compression must not erase it. */
    readonly toolkits: ReadonlyArray<{
      readonly name: string;
      readonly description: string;
    }>;
  }>;
};

const routingManifestCommitSchema = z.object({
  default: z.string().trim().min(1).max(200).nullable(),
  capabilities: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    purpose: z.string().trim().min(1).max(300),
    cues: z.array(z.string().trim().min(1).max(80)).min(3).max(6),
  }).strict()),
}).strict();

type RoutingManifestCommit = z.infer<typeof routingManifestCommitSchema>;

const routingManifestCommitTool = tool(
  async (input: RoutingManifestCommit) => JSON.stringify(input),
  {
    name: CAPABILITY_ROUTING_MANIFEST_COMMIT_TOOL_NAME,
    description: 'Commit the complete compact routing manifest for the supplied Capability registry manifest.',
    schema: routingManifestCommitSchema,
  },
);

export function createCapabilityRegistryManifest(params: {
  workspace: CapabilityDocumentWorkspace;
  defaultCapabilityName?: string;
}): CapabilityRegistryManifest {
  const requestedDefault = params.defaultCapabilityName
    ?? GENERAL_CAPABILITY_NAME;
  const defaultCapabilityName = params.workspace.capabilityNames.includes(
    requestedDefault,
  ) ? requestedDefault : undefined;
  return Object.freeze({
    ...(defaultCapabilityName ? { defaultCapabilityName } : {}),
    capabilities: Object.freeze(params.workspace.entries.map((entry) =>
      Object.freeze({
        name: entry.capabilityName,
        description: entry.description,
        toolkits: Object.freeze(entry.toolkits.map((toolkit) =>
          Object.freeze({ ...toolkit }),
        )),
      })),
    ),
  });
}

export function createDeterministicCapabilityRoutingManifest(
  source: CapabilityRegistryManifest,
): CapabilityRoutingManifest {
  return Object.freeze({
    ...(source.defaultCapabilityName
      ? { defaultCapabilityName: source.defaultCapabilityName }
      : {}),
    capabilities: Object.freeze(source.capabilities.map((entry) =>
      Object.freeze({
        name: entry.name,
        purpose: entry.description,
        cues: Object.freeze([
          entry.name,
          ...entry.toolkits.map(({ name }) => name),
        ]),
        toolkits: entry.toolkits,
      })),
    ),
  });
}

function parseRoutingManifestCommit(
  value: unknown,
  source: CapabilityRegistryManifest,
): CapabilityRoutingManifest {
  const commit = routingManifestCommitSchema.parse(value);
  if ((commit.default ?? undefined) !== source.defaultCapabilityName) {
    throw new Error('Capability routing manifest changed the configured default.');
  }
  const sourceNames = source.capabilities.map(({ name }) => name);
  const committedNames = commit.capabilities.map(({ name }) => name);
  if (
    committedNames.length !== sourceNames.length
    || new Set(committedNames).size !== committedNames.length
    || sourceNames.some((name) => !committedNames.includes(name))
  ) {
    throw new Error('Capability routing manifest must preserve every source Capability exactly once.');
  }
  const committedByName = new Map(commit.capabilities.map((entry) => [
    entry.name,
    entry,
  ]));
  return Object.freeze({
    ...(source.defaultCapabilityName
      ? { defaultCapabilityName: source.defaultCapabilityName }
      : {}),
    capabilities: Object.freeze(sourceNames.map((name) => {
      const entry = committedByName.get(name)!;
      const sourceEntry = source.capabilities.find(
        (candidate) => candidate.name === name,
      )!;
      const cues = entry.cues.map((cue) => cue.trim());
      if (new Set(cues.map((cue) => cue.toLowerCase())).size !== cues.length) {
        throw new Error(`Capability routing cues for "${name}" must not contain duplicates.`);
      }
      return Object.freeze({
        name,
        purpose: entry.purpose.trim(),
        cues: Object.freeze(cues),
        toolkits: sourceEntry.toolkits,
      });
    })),
  });
}

function routingManifestSourceText(source: CapabilityRegistryManifest) {
  return JSON.stringify({
    default: source.defaultCapabilityName ?? null,
    capabilities: source.capabilities,
  });
}

export async function initializeCapabilityRoutingManifest(params: {
  model: BaseChatModel;
  source: CapabilityRegistryManifest;
  runnableConfig?: RunnableConfig;
}): Promise<CapabilityRoutingManifest> {
  if (params.source.capabilities.length === 0 || !params.model.bindTools) {
    return createDeterministicCapabilityRoutingManifest(params.source);
  }
  try {
    const boundModel = params.model.bindTools([routingManifestCommitTool]);
    const response = await boundModel.invoke([
      new SystemMessage(CAPABILITY_ROUTING_MANIFEST_SYSTEM_PROMPT.render({})),
      createInvocationContextMessage({
        name: 'capability_routing_manifest_input',
        content: CAPABILITY_ROUTING_MANIFEST_INPUT_PROMPT.render({
          sourceManifest: xmlTextBlock(
            'capability_registry_manifest',
            routingManifestSourceText(params.source),
            ' role="fact" source="compiled_registry" trust="read_only"',
          ),
        }),
      }),
    ], {
      ...params.runnableConfig,
      runName: 'framework.capability_planner.routing_manifest',
      tags: [
        ...(params.runnableConfig?.tags ?? []),
        'framework.capability_planner.routing_manifest',
      ],
      metadata: {
        ...(params.runnableConfig?.metadata ?? {}),
        frameworkComponent: 'capability_planner_routing_manifest',
      },
    });
    params.runnableConfig?.signal?.throwIfAborted();
    if (!AIMessage.isInstance(response)) {
      throw new Error('Capability routing manifest initializer returned a non-AI message.');
    }
    const commit = response.tool_calls?.find(
      ({ name }) => name === CAPABILITY_ROUTING_MANIFEST_COMMIT_TOOL_NAME,
    );
    if (!commit) {
      throw new Error('Capability routing manifest initializer did not call its commit tool.');
    }
    return parseRoutingManifestCommit(commit.args, params.source);
  } catch (error) {
    params.runnableConfig?.signal?.throwIfAborted();
    console.warn('[pet-agent] Capability routing manifest initialization failed; using deterministic routing:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return createDeterministicCapabilityRoutingManifest(params.source);
  }
}

export function createCapabilityRoutingManifestResolver(params: {
  model: BaseChatModel;
}) {
  const cache = new Map<string, Promise<CapabilityRoutingManifest>>();

  function waitForManifest(
    manifest: Promise<CapabilityRoutingManifest>,
    signal: AbortSignal | undefined,
  ) {
    if (!signal) return manifest;
    signal.throwIfAborted();
    return new Promise<CapabilityRoutingManifest>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        try {
          signal.throwIfAborted();
        } catch (error) {
          reject(error);
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void manifest.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  return async (input: {
    workspace: CapabilityDocumentWorkspace;
    defaultCapabilityName?: string;
    runnableConfig?: RunnableConfig;
  }) => {
    const source = createCapabilityRegistryManifest(input);
    const cacheKey = `${input.workspace.registryDigest}\0${source.defaultCapabilityName ?? ''}`;
    let manifest = cache.get(cacheKey);
    if (!manifest) {
      const { signal: _invocationSignal, ...sharedConfig } =
        input.runnableConfig ?? {};
      manifest = initializeCapabilityRoutingManifest({
        model: params.model,
        source,
        runnableConfig: sharedConfig,
      });
      cache.set(cacheKey, manifest);
      void manifest.catch(() => {
        if (cache.get(cacheKey) === manifest) cache.delete(cacheKey);
      });
    }
    return waitForManifest(manifest, input.runnableConfig?.signal);
  };
}
