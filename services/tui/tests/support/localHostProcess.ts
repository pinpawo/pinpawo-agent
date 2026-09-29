import {
  FileCapabilityArtifactStore,
} from '../../../host/src/capabilityArtifactStore';
import {
  buildAgentContext,
} from '../../../host/src/contextLoader';
import {
  startLocalServer,
} from '../../../host/src/server';
import {
  buildHostRuntimeConfig,
} from '../../../host/src/config/runtimeConfig';
import {
  createTestModelServerDeps,
} from '../../../host/src/testing/modelProfiles';
import {
  createTestHostToolkitInventory,
} from '../../../host/src/testing/toolkitInventory';
import {
  createBashToolkit,
  createGitToolkit,
  PosixShellRS,
} from '../../../host/src/toolkits/local/index';
import { createPersistentHostGraphService } from './persistentHostGraphService';
import {
  createProductionToolkitHostGraphService,
} from './productionToolkitHostGraphService';

const requestedPort = Number(process.argv[2]);
const workdir = process.argv[3]?.trim();
const authToken = process.argv[4]?.trim();
const fixture = process.argv[5]?.trim() || 'persistent';

if (
  !Number.isInteger(requestedPort)
  || requestedPort < 0
  || requestedPort > 65_535
  || !workdir
  || !authToken
  || (fixture !== 'persistent' && fixture !== 'toolkit')
) {
  throw new Error(
    'usage: localHostProcess.ts <port> <workdir> <auth-token> [persistent|toolkit]',
  );
}

const runtimeConfig = buildHostRuntimeConfig(workdir);
const graphService = fixture === 'toolkit'
  ? createProductionToolkitHostGraphService()
  : createPersistentHostGraphService();
const shell = new PosixShellRS();
const toolkits = [createBashToolkit({ shell }), createGitToolkit({ shell })];
const transport = await startLocalServer(requestedPort, {
  petId: 'pet-process-restart',
  petName: 'PinPawo',
  serverMode: 'chat',
  runtimeConfig,
  ...createTestModelServerDeps({
    apiKey: 'offline-process-key',
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'process-restart-model',
    contextWindowTokens: 32_000,
  }),
  toolkitInventory: createTestHostToolkitInventory(toolkits),
  capabilityArtifactStore: new FileCapabilityArtifactStore(
    runtimeConfig.capabilityArtifactRoot,
  ),
}, {
  authToken,
  handlerOptions: {
    chatGraphService: graphService,
    loadContext: async (petId) => buildAgentContext(petId),
  },
});

process.stdout.write(`${JSON.stringify({
  type: 'ready',
  port: transport.port,
})}\n`);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  transport.close();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await transport.closed;
} finally {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
