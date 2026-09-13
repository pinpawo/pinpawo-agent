import { tool } from '@langchain/core/tools';
import {
  ARTIFACT_DISCOVERY_LIST_TOOL_NAME,
  ARTIFACT_DISCOVERY_READ_TOOL_NAME,
  type CapabilityArtifactStore,
} from '@pinpawo/pet-agent';
import { z } from 'zod';

function errorMessage(error: unknown) {
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

export function createArtifactDiscoveryTools(params: {
  store: CapabilityArtifactStore;
  threadId: string;
}) {
  const listArtifactsTool = tool(
    async ({
      capabilityId,
      kind,
      limit,
    }: {
      capabilityId?: string;
      kind?: string;
      limit?: number;
    }) => {
      try {
        const refs = await params.store.listArtifacts({
          threadId: params.threadId,
          capabilityId,
          kind,
          limit,
        });
        return refs.length > 0
          ? JSON.stringify(refs, null, 2)
          : '(no artifacts in the current thread)';
      } catch (error) {
        return errorMessage(error);
      }
    },
    {
      name: ARTIFACT_DISCOVERY_LIST_TOOL_NAME,
      description: '列出当前会话中已保存的产物，包含可供读取的地址。',
      schema: z.object({
        capabilityId: z.string().min(1).optional().describe('按产物列表中的 capabilityId 筛选来源'),
        kind: z.string().min(1).optional().describe('按产物类型筛选'),
        limit: z.number().int().min(1).max(100).optional().describe('最多返回多少条，默认 20'),
      }),
    },
  );

  const readArtifactTool = tool(
    async ({ uri, maxBytes }: { uri: string; maxBytes?: number }) => {
      try {
        const artifact = await params.store.readArtifact({
          uri,
          threadId: params.threadId,
          maxBytes,
        });
        return JSON.stringify(artifact, null, 2);
      } catch (error) {
        return errorMessage(error);
      }
    },
    {
      name: ARTIFACT_DISCOVERY_READ_TOOL_NAME,
      description: '读取当前会话中已保存产物的信息和文本内容。',
      schema: z.object({
        uri: z.string().min(1).describe('artifact_list 返回的产物地址 uri'),
        maxBytes: z.number().int().min(1).max(64_000).optional()
          .describe('最多读取的文本字节数，默认 64000'),
      }),
    },
  );

  return [listArtifactsTool, readArtifactTool];
}
