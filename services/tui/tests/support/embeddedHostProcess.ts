/**
 * Deterministic stdio Host fixture for the embedded transport test.
 *
 * It composes the production host handlers around a scripted graph
 * service and attaches the real JSONL stdio transport to this process, so the
 * test exercises the actual child-process pipe instead of a fake.
 *
 * stdout carries protocol messages only; diagnostics go to stderr.
 */
import {
  FileCapabilityArtifactStore,
} from '../../../host/src/capabilityArtifactStore';
import {
  buildAgentContext,
} from '../../../host/src/contextLoader';
import {
  createChatHostHandlers,
} from '../../../host/src/serverHandlers';
import {
  createChatHostDepsStore,
} from '../../../host/src/serverTypes';
import {
  attachHostStdioTransport,
  redirectConsoleToStdioDiagnostics,
} from '../../../host/src/wire/stdioTransport';
import {
  buildHostRuntimeConfig,
} from '../../../host/src/config/runtimeConfig';
import {
  createTestModelServerDeps,
} from '../../../host/src/testing/modelProfiles';
import {
  createTestHostToolkitInventory,
} from '../../../host/src/testing/toolkitInventory';
import { createFilesToolkit } from '../../../host/src/toolkits/files/index';
import { createGitToolkit } from '../../../host/src/toolkits/git/index';
import { createGithubToolkit } from '../../../host/src/toolkits/github/index';
import { createShellToolkit } from '../../../host/src/toolkits/shell/index';
import { PosixShellRS } from '../../../host/src/toolkits/shellRS/index';
import { createWebToolkit } from '../../../host/src/toolkits/web/index';
import { createHostGraphFixture } from './hostGraphFixture';

const sharedShell = new PosixShellRS();

const workdir = process.argv[2]?.trim();
if (!workdir) {
  throw new Error('usage: embeddedHostProcess.ts <workdir>');
}

// Mirror `pinpawo run --stdio`: stdout is reserved for protocol frames.
redirectConsoleToStdioDiagnostics();

const runtimeConfig = buildHostRuntimeConfig(workdir);
const graphFixture = createHostGraphFixture();
const handlers = createChatHostHandlers(
  createChatHostDepsStore({
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
      createFilesToolkit(), createShellToolkit({ shell: sharedShell }), createWebToolkit(), createGitToolkit({ shell: sharedShell }), createGithubToolkit({ shell: sharedShell }),
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

const transport = attachHostStdioTransport(handlers.peerHandlers);

try {
  await transport.closed;
} finally {
  handlers.close();
}
