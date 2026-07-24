import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import {
  defineCapability,
  defineInstructionDocument,
  type AgentCapability,
} from '../../types/capability';
import type { PetAgentStatus } from '../../types/studio';
import { defineToolkit } from '../../types/toolkit';
import type {
  AgentToolkit,
  NamedStructuredTool,
  ToolOperationMetadata,
} from '../../types/toolkit';
import type { StudioPlannerTaskInput } from './types';

/**
 * Studio 提供给 planner agent 的系统能力。
 *
 * planner agent 在被 Studio 调用时,会被装备这个 capability。它的工具
 * `enqueue_tasks` 接收结构化的 task 列表(petId / brief / acceptanceCriteria / deps),
 * Studio 通过 enqueueTasks closure 把 task 塞进 runner queue。
 *
 * 这条 capability 不依赖 LLM 整理逻辑——planner 输出什么就捕获什么。
 */
export type CreatePlanCapabilityOptions = {
  enqueueTasks: (tasks: StudioPlannerTaskInput[]) => void;
  listPets?: () => StudioPlanPetListItem[] | Promise<StudioPlanPetListItem[]>;
};

export type StudioPlanPetListItem = {
  petId: string;
  role?: string | null;
  serviceSummary?: string | null;
  status: PetAgentStatus;
};

const listPetsSchema = z.object({});

const dependencySchema = z.union([
  z.literal('previous'),
  z.object({ taskIndex: z.number().int().nonnegative() }),
]);

const enqueueTasksSchema = z.object({
  tasks: z
    .array(
      z.object({
        petId: z.string().min(1).describe('执行该 task 的 pet 标识'),
        brief: z.string().min(1).describe('本棒要完成的具体任务说明(自然语言)'),
        acceptanceCriteria: z
          .array(z.string())
          .optional()
          .describe('该 task 的验收标准列表,可选'),
        deps: z
          .array(dependencySchema)
          .optional()
          .describe('该 task 依赖的同 run 任务。省略表示无依赖; previous 表示依赖上一个 queue item。'),
      }),
    )
    .min(1)
    .describe('task 列表,顺序即入队顺序;数组下标(0 开始)即 taskIndex'),
});

type EnqueueTasksInput = z.infer<typeof enqueueTasksSchema>;

function readTasks(input: unknown) {
  if (!input || typeof input !== 'object' || !('tasks' in input)) {
    return [];
  }
  const tasks = (input as { tasks?: unknown }).tasks;
  return Array.isArray(tasks) ? tasks : [];
}

const planCapabilityOperationMetadata = {
  list_pets: {
    title: '查看 pets',
    summarizeInput: () => ({ summary: '查看 Studio pets' }),
    summarizeOutput: (output: unknown) => {
      if (typeof output !== 'string') {
        return null;
      }
      try {
        const parsed = JSON.parse(output) as { pets?: unknown };
        return Array.isArray(parsed.pets)
          ? { summary: `看到 ${parsed.pets.length} 个 pet` }
          : null;
      } catch {
        return null;
      }
    },
  },
  enqueue_tasks: {
    title: '加入任务队列',
    summarizeInput: (input: unknown) => {
      const tasks = readTasks(input);
      const petIds = tasks
        .map((task) => task && typeof task === 'object' && 'petId' in task
          ? (task as { petId?: unknown }).petId
          : null)
        .filter((petId): petId is string => typeof petId === 'string' && petId.length > 0);
      return {
        summary: `提交 ${tasks.length} 个任务`,
        details: {
          taskCount: tasks.length,
          petIds,
        },
      };
    },
    summarizeOutput: (output: unknown) => {
      if (typeof output !== 'string') {
        return null;
      }
      try {
        const parsed = JSON.parse(output) as { taskCount?: unknown };
        return typeof parsed.taskCount === 'number'
          ? { summary: `已接收 ${parsed.taskCount} 个任务` }
          : null;
      } catch {
        return null;
      }
    },
  },
} satisfies Record<string, ToolOperationMetadata>;

export function createPlanToolkit(
  options: Pick<CreatePlanCapabilityOptions, 'listPets' | 'enqueueTasks'>,
): AgentToolkit {
  const listPets = tool(
    async () => {
      const pets = await options.listPets?.() ?? [];
      return JSON.stringify({ pets });
    },
    {
      name: 'list_pets',
      description: '列出当前 Studio 内可供规划参考的 pets,包含 petId、职责摘要和当前状态。'
        + '选择 worker 前先调用它,不要凭空猜测 petId。',
      schema: listPetsSchema,
    },
  ) as NamedStructuredTool<'list_pets'>;

  const enqueueTasks = tool(
    async (input: EnqueueTasksInput) => {
      const { tasks } = input;
      const queuedTasks: StudioPlannerTaskInput[] = tasks.map((task) => ({
        petId: task.petId,
        brief: task.brief,
        acceptanceCriteria: task.acceptanceCriteria ?? [],
        deps: task.deps ?? [],
      }));
      options.enqueueTasks(queuedTasks);
      return JSON.stringify({ ok: true, taskCount: queuedTasks.length });
    },
    {
      name: 'enqueue_tasks',
      description: 'Planner 角色的**主要工具**:把 worker tasks 加入 Studio runner queue。'
        + '应该在分析完用户请求后调用。提交后 planner 不执行任务,由 Studio 按 FIFO、deps 与 pet 状态调度。',
      schema: enqueueTasksSchema,
    },
  ) as NamedStructuredTool<'enqueue_tasks'>;

  return defineToolkit({
    name: 'studio_plan',
    description: 'Studio planner 查询可用 pets 并提交任务计划。',
    tools: [
      {
        tool: listPets,
        operation: planCapabilityOperationMetadata.list_pets,
      },
      {
        tool: enqueueTasks,
        operation: planCapabilityOperationMetadata.enqueue_tasks,
      },
    ] as const,
  });
}

export function createPlanCapability(): AgentCapability {
  return defineCapability({
    name: 'studio_plan',
    description: 'Planner 唯一的目标:把用户请求拆解为 worker tasks 并加入 Studio runner queue。'
      + 'tasks 入队后 planner 退出,workers 接手执行 —— planner 本身不做实际工作。',
    uses: ['studio_plan'],
    instructions: defineInstructionDocument({
      source: { kind: 'inline', id: 'builtin:studio_plan' },
      content: [
        // 角色定位:规划者,不是执行者
        '【你的角色】你是 Studio 的 **planner**。'
          + '你的产出是写入 Studio runner queue 的 worker tasks。'
          + '**你不是执行者**,真正干活的是后续的 worker pets。你的角色到 task 入队完就结束。',

        // 职责边界:做什么 / 不做什么
        '【职责边界】'
          + '✓ 分析用户请求,理解目标。'
          + '✓ 需要选择 worker 时先调用 `list_pets`,读取当前 Studio pets 的职责与状态。'
          + '✓ 把目标拆解成 task 列表,为每个 task 指定 worker (petId) + brief + 验收(可选) + deps(可选)。'
          + '✓ 默认 deps 省略即可;只有确实需要等待前序 task 完成时才填 deps,例如 `previous`。'
          + '✓ 关键信息缺失时,通过 ask_user(HITL)问清楚 —— 但**只问 plan 真正需要的信息**(目标受众、风格、长度、必含内容等),'
          + '问完后立即基于答复完成 plan。'
          + '✗ 不要自己去做任务(不要写脚本、不要搜资料、不要 grep wiki、不要"我来帮你...")。'
          + '✗ 不要把所有事都揽到自己身上,你只规划。',

        // HITL 的用法
        '【何时用 ask_user】信息缺失到无法做出合理 plan 时,用 ask_user 一次性问关键问题。'
          + '问完后基于答复立刻 enqueue_tasks。**不要 finish + 在 reply 里写问题**(后者会让 turn stop,用户答复会跑到别的路径)。',

        // 提交方式
        '【提交方式】完成规划后,调一次 `enqueue_tasks`,提交 worker tasks。'
          + '提交后简短回复一句(例如 "已入队 N 个任务,接下来由 worker 执行")作为收尾,**不再调用任何其它工具,不再承诺任何事**。'
          + '你的工作到此结束,接下来 Studio 会自动调度 workers。',

        // 真无法规划
        '【无法规划】如果用户请求完全超出 Studio 能力范围或意图根本不明,可以选 finish 说明,turn 会被视为 stop,用户可在下一 turn 补充后重新触发。',
      ].join('\n\n'),
    }),
  });
}
