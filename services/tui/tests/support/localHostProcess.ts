import {
  FileCapabilityArtifactStore,
} from '../../../local-agent/src/capabilityArtifactStore';
import {
  buildLocalOnlyAgentContext,
} from '../../../local-agent/src/contextLoader';
import {
  startLocalServer,
} from '../../../local-agent/src/localServer';
import {
  buildLocalAgentRuntimeConfig,
} from '../../../local-agent/src/runtimeConfig';
import {
  createBashToolkit,
  createGitToolkit,
} from '../../../local-agent/src/toolkits/local/index';
import { createPersistentHostGraphService } from './persistentHostGraphService';

const requestedPort = Number(process.argv[2]);
const workdir = process.argv[3]?.trim();
const authToken = process.argv[4]?.trim();

if (
  !Number.isInteger(requestedPort)
  || requestedPort < 0
  || requestedPort > 65_535
  || !workdir
  || !authToken
) {
  throw new Error(
    'usage: localHostProcess.ts <port> <workdir> <auth-token>',
  );
}

const runtimeConfig = buildLocalAgentRuntimeConfig(workdir);
const graphService = createPersistentHostGraphService();
const toolkits = [createBashToolkit(), createGitToolkit()];
const transport = await startLocalServer(requestedPort, {
  actorId: 'pet-process-restart',
  actorName: 'PinPawo',
  workdir,
  runtimeConfig,
  llmConfig: {
    apiKey: 'offline-process-key',
    baseUrl: 'http://127.0.0.1:1/v1',
    model: 'process-restart-model',
    contextWindowTokens: 32_000,
  },
  localToolkitDefinitions: toolkits,
  localToolkits: toolkits,
  capabilityArtifactStore: new FileCapabilityArtifactStore(
    runtimeConfig.capabilityArtifactRoot,
  ),
}, {
  authToken,
  handlerOptions: {
    chatGraphService: graphService,
    loadContext: async (actorId) => buildLocalOnlyAgentContext(actorId),
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
