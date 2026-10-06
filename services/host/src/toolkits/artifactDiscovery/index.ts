import {
  ARTIFACT_DISCOVERY_LIST_TOOL_NAME,
  ARTIFACT_DISCOVERY_READ_TOOL_NAME,
  ARTIFACT_DISCOVERY_TOOLKIT_NAME,
  defineToolkit,
  type AgentToolkit,
  type CapabilityArtifactStore,
} from '@pinpawo/pet-agent';
import { createArtifactDiscoveryTools } from './artifactDiscoveryTools';

const operations: Record<string, { title: string }> = {
  [ARTIFACT_DISCOVERY_LIST_TOOL_NAME]: { title: '列出历史产物' },
  [ARTIFACT_DISCOVERY_READ_TOOL_NAME]: { title: '读取历史产物' },
};

export function createArtifactDiscoveryToolkit(params: {
  store: CapabilityArtifactStore;
  threadId: string;
}): AgentToolkit {
  return defineToolkit({
    name: ARTIFACT_DISCOVERY_TOOLKIT_NAME,
    description: '只读列出并读取当前 thread 的 capability artifacts。',
    tools: createArtifactDiscoveryTools(params).map((item) => ({ tool: item, operation: operations[item.name] })),
  });
}
