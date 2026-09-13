import { tool } from '@langchain/core/tools';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import type { StudioPetRegistration } from '../types';

/** Host-owned discovery; no dispatch, Plugin policy, or foreign Capability access. */
export function createStudioContextToolkit(listPets: () => StudioPetRegistration[]): AgentToolkit {
  return {
    name: 'studio-context',
    description: '只读 Studio 环境信息：查询当前 resident Pet。Pet 是独立会话，列表不扩展当前 Pet 的 Capability。',
    tools: [{
      tool: tool(async () => JSON.stringify({
        pets: listPets().map(({ petId, name }) => ({ petId, name })),
      }), {
        name: 'studio_pet_list',
        description: '读取当前 Studio 中的独立 Pet 名录。返回 Pet 标识与名称，不是当前 Pet 可执行的 Capability；本工具不派发工作，也不读取其他 Pet 的会话。',
        schema: { type: 'object', properties: {}, additionalProperties: false },
      }),
      operation: { title: '查看 Studio Pet 名录' },
    }],
  };
}
