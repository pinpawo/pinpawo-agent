import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import type { AgentCapability } from '../../types/capability';
import { defineToolset } from '../../types/toolkit';
import type { AgentToolset, NamedStructuredTool, ToolkitOperationMetadata } from '../../types/toolkit';
import type { StudioTask, StudioTaskPlan } from './types';

/**
 * Studio 提供给 planner agent 的系统能力。
 *
 * planner agent 在被 Studio 调用时,会被装备这个 capability。它的工具
 * `submit_plan` 接收结构化的 task 列表(petId / goal / acceptanceCriteria),
 * Studio 通过 onSubmit closure 捕获 plan,用于后续 dispatch 循环。
 *
 * 这条 capability 不依赖 LLM 整理逻辑——planner 输出什么就捕获什么。
 */
export type CreatePlanCapabilityOptions = {
  onSubmit: (plan: StudioTaskPlan) => void;
  /**
   * 可选:供 planner LLM 选择 petId 时参考的 agent 描述。
   * 通常包含 petId / role / serviceSummary,以便 planner 做合理的 task→pet 分派。
   */
  availableAgents?: Array<{
    petId: string;
    role?: string | null;
    serviceSummary?: string | null;
  }>;
};

const submitPlanSchema = z.object({
  tasks: z
    .array(
      z.object({
        petId: z.string().min(1).describe('执行该 task 的 pet 标识'),
        goal: z.string().min(1).describe('本棒要完成的具体目标(自然语言)'),
        acceptanceCriteria: z
          .array(z.string())
          .optional()
          .describe('该 task 的验收标准列表,可选'),
      }),
    )
    .min(1)
    .describe('task 列表,顺序即执行顺序;数组下标(0 开始)即 task 身份'),
});

type SubmitPlanInput = z.infer<typeof submitPlanSchema>;

function buildAgentsHint(agents?: CreatePlanCapabilityOptions['availableAgents']): string | null {
  if (!agents || agents.length === 0) return null;
  const lines = agents.map((agent) => {
    const role = agent.role ? `(${agent.role})` : '';
    const summary = agent.serviceSummary ? `: ${agent.serviceSummary}` : '';
    return `- ${agent.petId}${role}${summary}`;
  });
  return ['当前 Studio 内可用的 agents:', ...lines].join('\n');
}

function readTasks(input: unknown) {
  if (!input || typeof input !== 'object' || !('tasks' in input)) {
    return [];
  }
  const tasks = (input as { tasks?: unknown }).tasks;
  return Array.isArray(tasks) ? tasks : [];
}

const planCapabilityOperationMetadata = {
  submit_plan: {
    title: '提交计划',
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
} satisfies Record<string, ToolkitOperationMetadata>;

function createPlanToolset(options: Pick<CreatePlanCapabilityOptions, 'onSubmit'>): AgentToolset {
  const submitPlan = tool(
    async (input: SubmitPlanInput) => {
      const { tasks } = input;
      const plan: StudioTaskPlan = {
        tasks: tasks.map((task): StudioTask => ({
          petId: task.petId,
          goal: task.goal,
          acceptanceCriteria: task.acceptanceCriteria ?? [],
          status: 'pending',
          retryCount: 0,
        })),
      };
      options.onSubmit(plan);
      return JSON.stringify({ ok: true, taskCount: plan.tasks.length });
    },
    {
      name: 'submit_plan',
      description: 'Planner 角色的**主要工具**:一次性提交本次 turn 的完整任务计划(有序 task 列表)。'
        + '应该在分析完用户请求后立即调用,无需先用其它工具探索。提交即视为规划完成,不要重复调用。',
      schema: submitPlanSchema,
    },
  ) as NamedStructuredTool<'submit_plan'>;

  return defineToolset({
    name: 'studio_plan',
    description: 'Studio planner 提交任务计划的 capability-private toolset。',
    tools: [submitPlan] as const,
    operations: planCapabilityOperationMetadata,
  });
}

export function createPlanCapability(options: CreatePlanCapabilityOptions): AgentCapability {
  const agentsHint = buildAgentsHint(options.availableAgents);

  return {
    name: 'studio_plan',
    description: 'Planner 唯一的目标:把用户请求拆解为一份 plan(有序 task 列表),指定每棒由哪个 worker pet 执行 + 目标。'
      + 'plan 提交后 planner 退出,workers 接手执行 —— planner 本身不做实际工作。',
    createRuntime() {
      const instructions = [
        // 角色定位:规划者,不是执行者
        '【你的角色】你是 Studio 的 **planner**。'
          + '你的产出是一份 **plan** —— 一份让 worker pets 去执行的有序 task 列表。'
          + '**你不是执行者**,真正干活的是后续的 worker pets。你的角色到 plan 提交完就结束。',

        // 职责边界:做什么 / 不做什么
        '【职责边界】'
          + '✓ 分析用户请求,理解目标。'
          + '✓ 把目标拆解成有序 task 列表,为每个 task 指定 worker (petId) + 目标 (goal) + 验收(可选)。'
          + '✓ 关键信息缺失时,通过 ask_user(HITL)问清楚 —— 但**只问 plan 真正需要的信息**(目标受众、风格、长度、必含内容等),'
          + '问完后立即基于答复完成 plan。'
          + '✗ 不要自己去做任务(不要写脚本、不要搜资料、不要 grep wiki、不要"我来帮你...")。'
          + '✗ 不要把所有事都揽到自己身上,你只规划。',

        // HITL 的用法
        '【何时用 ask_user】信息缺失到无法做出合理 plan 时,用 ask_user 一次性问关键问题。'
          + '问完后基于答复立刻 submit_plan。**不要 finish + 在 reply 里写问题**(后者会让 turn stop,用户答复会跑到别的路径)。',

        // 提交方式
        '【提交方式】完成规划后,调一次 `submit_plan`,一口气提交完整 plan。'
          + '提交后简短回复一句(例如 "已规划 N 棒,接下来由 worker 执行")作为收尾,**不再调用任何其它工具,不再承诺任何事**。'
          + '你的工作到此结束,接下来 Studio 会自动 dispatch workers。',

        // 真无法规划
        '【无法规划】如果用户请求完全超出 Studio 能力范围或意图根本不明,可以选 finish 说明,turn 会被视为 stop,用户可在下一 turn 补充后重新触发。',
      ];
      if (agentsHint) instructions.push(agentsHint);

      return {
        toolsets: [createPlanToolset(options)],
        instructions,
      };
    },
  };
}
