/**
 * Cross-package model evaluation for the Studio Planner Capability.
 *
 * The evaluation intentionally uses the production Capability document and
 * production Kanban Toolkit. This keeps tool schemas and descriptions aligned
 * with the behavior shipped by the Plugin instead of duplicating them in an
 * agent-runtime eval fixture.
 */
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  createSubagent,
  parseCapabilityDocument,
  readMessageToolCalls,
} from '@pinpawo/pet-agent';
import {
  createInMemoryKanbanTaskService,
  createKanbanPlanningToolkit,
} from '@pinpawo-plugin/kanban';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { createDecisionEvalModel } from '../../../packages/pet-agent/evals/scripts/decision-eval-model';

const CAPABILITY_PATH = resolve(
  import.meta.dirname,
  '../../../packages/studio/examples/kanban-workdir/.pinpawo/pets/planner/capabilities/studio-planning/CAPABILITY.md',
);
function readDefaultProfileId(): string {
  const configured = process.env.STUDIO_PLANNING_EVAL_PROFILE?.trim();
  if (configured) return configured;
  const configPath = resolve(homedir(), '.pinpawo', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    models?: { defaultProfileId?: unknown };
  };
  const defaultProfileId = config.models?.defaultProfileId;
  if (typeof defaultProfileId !== 'string' || !defaultProfileId.trim()) {
    throw new Error(
      'Set STUDIO_PLANNING_EVAL_PROFILE or configure models.defaultProfileId in ~/.pinpawo/config.json.',
    );
  }
  return defaultProfileId.trim();
}

function readMessageText(message: BaseMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.flatMap((block) => {
    if (typeof block === 'string') return [block];
    if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
      return [block.text];
    }
    return [];
  }).join('');
}

function countToolCalls(messages: BaseMessage[]) {
  const calls = messages.flatMap((message) => readMessageToolCalls(message));
  return {
    calls,
    count: (name: string) => calls.filter((call) => call.name === name).length,
  };
}

function findFinalResponse(messages: BaseMessage[]): BaseMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (AIMessage.isInstance(message) && readMessageToolCalls(message).length === 0) {
      return message;
    }
  }
  return undefined;
}

async function main() {
  const profileId = readDefaultProfileId();
  const subject = createDecisionEvalModel({ profileId, role: 'subject' });
  const capability = parseCapabilityDocument(
    readFileSync(CAPABILITY_PATH, 'utf8'),
    CAPABILITY_PATH,
  );
  const service = createInMemoryKanbanTaskService();
  await service.init();

  const kanbanToolkit = createKanbanPlanningToolkit(service);

  try {
    const result = await createSubagent({
      model: subject.model,
      tools: [
        ...kanbanToolkit.tools.map(({ tool: declaredTool }) => declaredTool),
      ],
      promptSections: [{
        id: 'capability:studio_planning',
        owner: 'studio_planning',
        content: capability.body,
      }],
      messages: [new HumanMessage([
        '为 issue #101 建立最小完整 task 图。',
        '已确认的工作是：改进 task 列表的标题与详情展示并补齐回归测试；实现完成后由 Reviewer 独立审查。',
        'Wiki 会由 task.done Trigger 自动对齐并沿事件流程推进。',
        '项目事实已经充分，当前 task 快照为空。',
      ].join('\n'))],
      maxIterations: 8,
    });

    const snapshot = await service.readSnapshot();
    const toolCalls = countToolCalls(result.messages);
    const [executorTask, reviewerTask] = snapshot.tasks;
    const finalMessage = findFinalResponse(result.messages);
    const failures = [
      result.completionReason === 'natural'
        ? null
        : `completion reason: ${result.completionReason}`,
      snapshot.tasks.length === 2
        ? null
        : `created ${snapshot.tasks.length.toString()} tasks instead of 2`,
      executorTask ? null : 'executor task is missing',
      reviewerTask ? null : 'reviewer task is missing',
      reviewerTask && executorTask && reviewerTask.deps.includes(executorTask.taskId)
        ? null
        : 'reviewer task does not depend on executor task',
      snapshot.tasks.some(({ assigneeId }) => assigneeId !== undefined)
        ? 'Planner assigned a task instead of leaving assignment to the user'
        : null,
      toolCalls.count('kanban_task_list') === 1
        ? null
        : `kanban_task_list called ${toolCalls.count('kanban_task_list').toString()} times`,
      toolCalls.count('kanban_task_add') === 2
        ? null
        : `kanban_task_add called ${toolCalls.count('kanban_task_add').toString()} times`,
      toolCalls.calls.at(-1)?.name === 'kanban_task_add'
        ? null
        : `last tool was ${toolCalls.calls.at(-1)?.name ?? '(none)'}`,
      finalMessage && readMessageText(finalMessage).trim()
        ? null
        : 'final response is empty',
    ].filter((failure): failure is string => Boolean(failure));

    console.log(`Studio Planner eval model: ${subject.label}`);
    console.log(`Tool calls: ${toolCalls.calls.map(({ name }) => name).join(' -> ')}`);
    console.log(`Tasks: ${snapshot.tasks.map((task) => task.taskId).join(', ')}`);
    if (failures.length > 0) {
      throw new Error(`Studio Planner eval failed:\n- ${failures.join('\n- ')}`);
    }
    console.log('PASS: Studio Planner created the minimal production Kanban task graph and stopped.');
  } finally {
    await service.close();
  }
}

await main();
