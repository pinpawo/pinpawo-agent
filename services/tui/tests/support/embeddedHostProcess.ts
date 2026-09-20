/**
 * Deterministic stdio Host fixture for the embedded transport test.
 *
 * It composes the production local-agent handlers around a scripted graph
 * service and attaches the real JSONL stdio transport to this process, so the
 * test exercises the actual child-process pipe instead of a fake.
 *
 * stdout carries protocol messages only; diagnostics go to stderr.
 */
import {
  FileCapabilityArtifactStore,
} from '../../../local-agent/src/capabilityArtifactStore';
import {
  buildAgentContext,
} from '../../../local-agent/src/contextLoader';
import {
  createLocalServerHandlers,
} from '../../../local-agent/src/serverHandlers';
import {
  createLocalServerRuntimeDepsStore,
} from '../../../local-agent/src/serverTypes';
import {
  attachLocalServerStdioTransport,
  redirectConsoleToStdioDiagnostics,
} from '../../../local-agent/src/wire/stdioTransport';
import {
  buildLocalAgentRuntimeConfig,
} from '../../../local-agent/src/config/runtimeConfig';
import {
  createTestModelServerDeps,
} from '../../../local-agent/src/testing/modelProfiles';
import {
  createTestHostToolkitInventory,
} from '../../../local-agent/src/testing/toolkitInventory';
import {
  createBashToolkit,
  createGitToolkit,
} from '../../../local-agent/src/toolkits/local/index';
import { createHostGraphFixture } from './hostGraphFixture';

const workdir = process.argv[2]?.trim();
if (!workdir) {
  throw new Error('usage: embeddedHostProcess.ts <workdir>');
}

// Mirror `pinpawo run --stdio`: stdout is reserved for protocol frames.
redirectConsoleToStdioDiagnostics();

const runtimeConfig = buildLocalAgentRuntimeConfig(workdir);
const graphFixture = createHostGraphFixture();
const handlers = createLocalServerHandlers(
  createLocalServerRuntimeDepsStore({
    serverMode: 'chat',
    petId: 'pet-embedded-host',
    petName: 'PinPawo',
    runtimeConfig,
    ...createTestModelServerDeps({
      apiKey: 'offline-embedded-host-key',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'embedded-host-model',
      contextWindowTokens: 32_000,
    }),
    toolkitInventory: createTestHostToolkitInventory([
      createBashToolkit(),
      createGitToolkit(),
    ]),
    capabilityArtifactStore: new FileCapabilityArtifactStore(
      runtimeConfig.capabilityArtifactRoot,
    ),
  }),
  {
    chatGraphService: graphFixture.service,
    loadContext: async (petId) => buildAgentContext(petId),
  },
);

const transport = attachLocalServerStdioTransport(handlers.peerHandlers);

try {
  await transport.closed;
} finally {
  handlers.close();
}
