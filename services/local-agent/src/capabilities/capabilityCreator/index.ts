import { type AgentCapability } from '@pinpawo/pet-agent';
import { capabilityCreatorInstructions } from './instructions';
import { capabilityCreatorResultSchema } from './schemas';
import { createCapabilityCreatorToolset } from './tools';

export function createCapabilityCreatorCapability(): AgentCapability {
  return {
    name: 'capability_creator',
    description: '生成、修改并验证用户自定义 capability 插件模板。',
    createRuntime: async (context) => ({
      toolsets: [createCapabilityCreatorToolset()],
      uses: ['bash'],
      contextPolicy: {
        evictToolResults: {
          keepRecent: 5,
          keepFailures: true,
        },
      },
      instructions: capabilityCreatorInstructions,
    }),
    resultSchema: capabilityCreatorResultSchema,
  };
}
