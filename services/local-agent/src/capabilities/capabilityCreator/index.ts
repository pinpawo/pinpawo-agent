import { type AgentCapability } from '@pinpawo/pet-agent';
import { capabilityCreatorInstructions } from './instructions';
import { capabilityCreatorResultSchema } from './schemas';
import { createCapabilityCreatorToolset } from './tools';
import { markLatestToolArtifactAsResult } from '../resultArtifactMarker';

export function createCapabilityCreatorCapability(): AgentCapability {
  return {
    name: 'capability_creator',
    description: '生成、修改并验证用户自定义 capability 插件模板。',
    createRuntime: async () => ({
      toolsets: [createCapabilityCreatorToolset()],
      uses: ['bash'],
      contextPolicy: {
        evictToolResults: {
          keepRecent: 5,
          budgetTokens: 24_000,
          keepFailures: true,
        },
      },
      middleware: {
        afterRun: (result) => markLatestToolArtifactAsResult(result, {
          schema: capabilityCreatorResultSchema,
          schemaName: 'CapabilityCreatorResult',
          title: 'Capability creator result',
        }),
      },
      instructions: capabilityCreatorInstructions,
    }),
    resultSchema: capabilityCreatorResultSchema,
  };
}
