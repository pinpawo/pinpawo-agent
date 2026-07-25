import {
  defineCapability,
  defineInstructionDocument,
  type AgentCapability,
} from '@pinpawo/pet-agent';
import { capabilityCreatorInstructions } from './instructions';

export function createCapabilityCreatorCapability(): AgentCapability {
  return defineCapability({
    name: 'capability_creator',
    description: '生成、修改并验证用户自定义 CAPABILITY.md 目录。',
    uses: ['bash', 'capability_creator'],
    instructions: defineInstructionDocument({
      content: capabilityCreatorInstructions,
    }),
  });
}

export { createCapabilityCreatorToolkit } from './tools';
