import { type AgentCapability } from '@pinpawo/pet-agent';
import { capabilityCreatorInstructions } from './instructions';
import { capabilityCreatorResultSchema } from './schemas';

export function createCapabilityCreatorCapability(): AgentCapability {
  return {
    name: 'capability_creator',
    description: '生成、修改并验证用户自定义 capability 插件模板。',
    uses: ['bash', 'capability_creator'],
    createRuntime: async () => ({
      instructions: capabilityCreatorInstructions,
    }),
    resultSchema: capabilityCreatorResultSchema,
  };
}

export { createCapabilityCreatorToolkit } from './tools';
