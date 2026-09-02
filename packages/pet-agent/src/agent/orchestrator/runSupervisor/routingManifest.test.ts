import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredTool } from '@langchain/core/tools';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';
import {
  CAPABILITY_ROUTING_MANIFEST_COMMIT_TOOL_NAME,
  createCapabilityRegistryManifest,
  createCapabilityRoutingManifestResolver,
  initializeCapabilityRoutingManifest,
} from './routingManifest';

function workspace(): CapabilityDocumentWorkspace {
  const entries = [{
    capabilityName: 'general',
    description: 'Handle ordinary workspace tasks.',
    toolkits: [{
      name: 'workspace',
      description: 'Read, edit, and verify files in the local workspace.',
    }],
    relativePath: 'general/CAPABILITY.md',
    documentDigest: 'a'.repeat(64),
    provenance: 'authored' as const,
  }, {
    capabilityName: 'github_project',
    description: 'Inspect and maintain GitHub Issues and Pull Requests.',
    toolkits: [{
      name: 'git',
      description: 'Inspect Git repositories and view or maintain GitHub Issues and Pull Requests.',
    }],
    relativePath: 'github_project/CAPABILITY.md',
    documentDigest: 'b'.repeat(64),
    provenance: 'authored' as const,
  }];
  return {
    rootPath: '/tmp/capability-routing-manifest',
    registryDigest: 'c'.repeat(64),
    capabilityNames: entries.map(({ capabilityName }) => capabilityName),
    entries,
    reused: false,
  };
}

function messageText(message: BaseMessage) {
  return typeof message.content === 'string' ? message.content : message.text;
}

class RoutingManifestModel extends BaseChatModel {
  invocationCount = 0;
  boundOptions: Record<string, unknown> | undefined;

  constructor(
    private readonly invalid = false,
    private readonly delayMs = 0,
  ) {
    super({});
  }

  _llmType() {
    return 'routing-manifest-test';
  }

  bindTools(tools: StructuredTool[], options?: Record<string, unknown>) {
    assert.deepEqual(tools.map(({ name }) => name), [
      CAPABILITY_ROUTING_MANIFEST_COMMIT_TOOL_NAME,
    ]);
    this.boundOptions = options;
    return this;
  }

  async _generate(messages: BaseMessage[]) {
    this.invocationCount += 1;
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.invalid) {
      const message = new AIMessage('ordinary text');
      return { generations: [{ message, text: message.text }] };
    }
    const sourceText = messageText(messages.at(-1)!).match(
      /<capability_registry_manifest[^>]*>\n<!\[CDATA\[\n([\s\S]*)\n\]\]>\n<\/capability_registry_manifest>/,
    )?.[1]?.replaceAll(']]]]><![CDATA[>', ']]>');
    const source = JSON.parse(sourceText ?? '{}') as {
      default?: string | null;
      capabilities: Array<{
        name: string;
        description: string;
        toolkits: Array<{ name: string; description: string }>;
      }>;
    };
    const message = new AIMessage({
      content: '',
      tool_calls: [{
        id: 'routing-manifest',
        name: CAPABILITY_ROUTING_MANIFEST_COMMIT_TOOL_NAME,
        args: {
          default: source.default ?? null,
          capabilities: [...source.capabilities].reverse().map((entry) => ({
            name: entry.name,
            purpose: entry.description,
            cues: entry.name === 'github_project'
              ? ['github', 'issue', 'pull request']
              : ['general', 'workspace', 'task'],
          })),
        },
        type: 'tool_call' as const,
      }],
    });
    return { generations: [{ message, text: '' }] };
  }
}

test('registry manifest contains every available Capability and the configured default', () => {
  assert.deepEqual(createCapabilityRegistryManifest({
    workspace: workspace(),
    defaultCapabilityName: 'github_project',
  }), {
    defaultCapabilityName: 'github_project',
    capabilities: [{
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      toolkits: [{
        name: 'workspace',
        description: 'Read, edit, and verify files in the local workspace.',
      }],
    }, {
      name: 'github_project',
      description: 'Inspect and maintain GitHub Issues and Pull Requests.',
      toolkits: [{
        name: 'git',
        description: 'Inspect Git repositories and view or maintain GitHub Issues and Pull Requests.',
      }],
    }],
  });
});

test('model initialization validates coverage and restores source order', async () => {
  const model = new RoutingManifestModel();
  const manifest = await initializeCapabilityRoutingManifest({
    model,
    source: createCapabilityRegistryManifest({
      workspace: workspace(),
      defaultCapabilityName: 'github_project',
    }),
  });

  assert.equal(model.invocationCount, 1);
  assert.equal(model.boundOptions?.tool_choice, undefined);
  assert.equal(manifest.defaultCapabilityName, 'github_project');
  assert.deepEqual(manifest.capabilities.map(({ name }) => name), [
    'general',
    'github_project',
  ]);
  assert.deepEqual(manifest.capabilities[1]?.cues, [
    'github',
    'issue',
    'pull request',
  ]);
  assert.deepEqual(manifest.capabilities[1]?.toolkits, [{
    name: 'git',
    description: 'Inspect Git repositories and view or maintain GitHub Issues and Pull Requests.',
  }]);
});

test('invalid initialization falls back without dropping routing coverage', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const manifest = await initializeCapabilityRoutingManifest({
    model: new RoutingManifestModel(true),
    source: createCapabilityRegistryManifest({ workspace: workspace() }),
  });

  assert.deepEqual(manifest.capabilities, [{
    name: 'general',
    purpose: 'Handle ordinary workspace tasks.',
    cues: ['general', 'workspace'],
    toolkits: [{
      name: 'workspace',
      description: 'Read, edit, and verify files in the local workspace.',
    }],
  }, {
    name: 'github_project',
    purpose: 'Inspect and maintain GitHub Issues and Pull Requests.',
    cues: ['github_project', 'git'],
    toolkits: [{
      name: 'git',
      description: 'Inspect Git repositories and view or maintain GitHub Issues and Pull Requests.',
    }],
  }]);
});

test('routing manifest initialization is cached by registry and default identity', async () => {
  const model = new RoutingManifestModel();
  const resolve = createCapabilityRoutingManifestResolver({ model });

  const first = await resolve({
    workspace: workspace(),
    defaultCapabilityName: 'general',
  });
  const second = await resolve({
    workspace: workspace(),
    defaultCapabilityName: 'general',
  });

  assert.equal(model.invocationCount, 1);
  assert.equal(first, second);
});

test('one caller abort does not cancel shared routing manifest initialization', async () => {
  const model = new RoutingManifestModel(false, 25);
  const resolve = createCapabilityRoutingManifestResolver({ model });
  const controller = new AbortController();

  const cancelled = resolve({
    workspace: workspace(),
    defaultCapabilityName: 'general',
    runnableConfig: { signal: controller.signal },
  });
  const surviving = resolve({
    workspace: workspace(),
    defaultCapabilityName: 'general',
  });
  controller.abort();

  await assert.rejects(cancelled, (error: unknown) =>
    error instanceof Error && error.name === 'AbortError');
  const manifest = await surviving;
  assert.equal(model.invocationCount, 1);
  assert.equal(manifest.defaultCapabilityName, 'general');
});
