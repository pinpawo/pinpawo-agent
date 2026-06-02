import type { AgentCapability } from '../../types/capability';
import { readLatestToolArtifact } from '../../agent/orchestrator/subagentHandoff';
import { capabilityCreatorInstructions } from './instructions';
import { capabilityCreatorResultSchema } from './schemas';
import { buildCapabilityCreatorTools, capabilityCreatorToolOperations } from './tools';

export function createCapabilityCreatorCapability(): AgentCapability {
  return {
    name: 'capability_creator',
    description: '生成、修改并验证用户自定义 capability 插件模板。',
    createRuntime: async () => ({
      tools: buildCapabilityCreatorTools(),
      operations: capabilityCreatorToolOperations,
      uses: ['bash'],
      instructions: capabilityCreatorInstructions,
      readResult: readLatestToolArtifact,
    }),
    resultSchema: capabilityCreatorResultSchema,
  };
}
