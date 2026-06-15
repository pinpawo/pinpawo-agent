import { type AgentCapability } from '@pinpawo/pet-agent';
import { capabilityCreatorInstructions } from './instructions';
import { capabilityCreatorResultSchema } from './schemas';
import { createCapabilityCreatorToolset } from './tools';

export function createCapabilityCreatorCapability(): AgentCapability {
  return {
    name: 'capability_creator',
    description: '生成、修改并验证用户自定义 capability 插件模板。',
    createRuntime: async () => ({
      toolsets: [createCapabilityCreatorToolset()],
      uses: ['bash', 'capability_artifact'],
      contextPolicy: {
        evictToolResults: {
          keepRecent: 5,
          budgetTokens: 24_000,
          keepFailures: true,
        },
      },
      instructions: [
        ...capabilityCreatorInstructions,
        '生成、验证或失败结果确定后，必须调用 capability_artifact_write 保存 kind=result、mimeType=application/json、title="Capability creator result"、schema={name:"CapabilityCreatorResult",version:1}，content 使用最终结果对象。',
      ],
    }),
    resultSchema: capabilityCreatorResultSchema,
  };
}
