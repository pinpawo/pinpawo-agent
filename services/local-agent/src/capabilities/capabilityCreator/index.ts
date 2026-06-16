import {
  type AgentCapability,
  type CapabilityArtifactStore,
} from '@pinpawo/pet-agent';
import { capabilityCreatorInstructions } from './instructions';
import { capabilityCreatorResultSchema } from './schemas';
import { createCapabilityCreatorToolset } from './tools';
import { recordLatestToolResultArtifact } from '../resultArtifact';

export type CapabilityCreatorCapabilityOptions = {
  artifactStore?: CapabilityArtifactStore;
};

export function createCapabilityCreatorCapability(
  options: CapabilityCreatorCapabilityOptions = {},
): AgentCapability {
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
      instructions: capabilityCreatorInstructions,
      middleware: {
        afterRun: (result, ctx) => recordLatestToolResultArtifact(result, ctx, {
          store: options.artifactStore,
          schema: capabilityCreatorResultSchema,
          title: 'Capability creator result',
          schemaName: 'CapabilityCreatorResult',
        }),
      },
    }),
    resultSchema: capabilityCreatorResultSchema,
  };
}
