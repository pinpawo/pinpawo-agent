import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  defineToolkit,
  type AgentActor,
  type AgentToolkit,
  type NamedStructuredTool,
  type ToolkitOperationMetadata,
} from '@pinpawo/pet-agent';

export type PetProfileToolOptions = {
  actor: AgentActor;
  profileText?: string | null;
};

function formatSelfIntroduction(actor: AgentActor) {
  const segments = [`我是${actor.name}`];

  if (actor.species) {
    segments.push(`一只${actor.species}`);
  }

  if (actor.stage) {
    segments.push(`现在处于${actor.stage}阶段`);
  }

  if (actor.personality) {
    segments.push(`性格偏${actor.personality}`);
  }

  return `${segments.join('，')}。`;
}

function selectProfileDetails(options: PetProfileToolOptions, focus?: string) {
  const normalizedFocus = focus?.trim();
  const lines = ['[Pet Profile]'];

  if (!normalizedFocus || /自我介绍|介绍|intro/i.test(normalizedFocus)) {
    lines.push(`自我介绍：${formatSelfIntroduction(options.actor)}`);
  }

  if (!normalizedFocus || /名字|name/i.test(normalizedFocus)) {
    lines.push(`名字：${options.actor.name}`);
  }

  if ((!normalizedFocus || /物种|species/i.test(normalizedFocus)) && options.actor.species) {
    lines.push(`物种：${options.actor.species}`);
  }

  if ((!normalizedFocus || /阶段|成长|stage/i.test(normalizedFocus)) && options.actor.stage) {
    lines.push(`阶段：${options.actor.stage}`);
  }

  if ((!normalizedFocus || /性格|personality/i.test(normalizedFocus)) && options.actor.personality) {
    lines.push(`性格：${options.actor.personality}`);
  }

  if (options.profileText?.trim()) {
    lines.push(`补充信息：${options.profileText.trim().slice(0, 600)}`);
  }

  return lines.join('\n');
}

function readFocus(input: unknown) {
  if (!input || typeof input !== 'object' || !('focus' in input)) {
    return null;
  }
  const focus = (input as { focus?: unknown }).focus;
  return typeof focus === 'string' && focus.trim()
    ? focus.trim()
    : null;
}

const petProfileOperationMetadata = {
  describe_pet_profile: {
    title: '读取宠物资料',
    summarizeInput: (input: unknown) => {
      const focus = readFocus(input);
      return {
        target: focus ?? undefined,
        summary: focus ? `查看 ${focus}` : '查看基础资料',
        details: focus ? { focus } : undefined,
      };
    },
  },
} satisfies Record<string, ToolkitOperationMetadata>;

export function createPetProfileTool(options: PetProfileToolOptions): StructuredTool {
  return tool(
    async ({ focus }) => selectProfileDetails(options, focus),
    {
      name: 'describe_pet_profile',
      description: '查看当前宠物的基本信息和自我介绍，可选聚焦名字、性格、物种、成长阶段等。',
      schema: z.object({
        focus: z.string().optional().describe('可选的查看重点，例如“自我介绍”“性格”“物种”“成长阶段”。'),
      }),
    },
  );
}

export function createPetProfileToolkit(options: PetProfileToolOptions): AgentToolkit {
  const petProfileTool = createPetProfileTool(options) as NamedStructuredTool<'describe_pet_profile'>;
  return defineToolkit({
    name: 'pet_profile',
    description: '读取当前宠物的基本信息、自我介绍和补充资料。',
    tools: [petProfileTool] as const,
    operations: petProfileOperationMetadata,
  });
}
