import { tool } from '@langchain/core/tools';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import type { StudioPetRegistration } from '../types';

/** Host-owned discovery; no dispatch, Plugin policy, or foreign Capability access. */
export function createStudioContextToolkit(listPets: () => StudioPetRegistration[]): AgentToolkit {
  return {
    name: 'studio-context',
    description: '查询当前 Studio 中有哪些 Pet。',
    tools: [{
      tool: tool(async () => JSON.stringify({
        pets: listPets().map(({ petId, name }) => ({ petId, name })),
      }), {
        name: 'studio_pet_list',
        description: '列出当前 Studio 中的 Pet，返回各自的标识和名称。',
        schema: { type: 'object', properties: {}, additionalProperties: false },
      }),
      operation: { title: '查看 Studio Pet 名录' },
    }],
  };
}
