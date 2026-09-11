/**
 * Cross-package model evaluation for the Studio Planner Capability.
 *
 * The evaluation intentionally uses the production Capability document and
 * production Kanban Toolkit. This keeps tool schemas and descriptions aligned
 * with the behavior shipped by the Plugin instead of duplicating them in an
 * agent-runtime eval fixture.
 */
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
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
  '../../../packages/studio/templates/default/pets/planner/capabilities/studio-planning/CAPABILITY.md',
);
const PET_PATH = resolve(import.meta.dirname, '../../../packages/studio/templates/default/pets/planner/PET.md');
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

function countToolCalls(messages: BaseMessage[]) {
  const calls = messages.flatMap((message) => readMessageToolCalls(message));
  return {
    calls,
    count: (name: string) => calls.filter((call) => call.name === name).length,
  };
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
    console.log(`Studio Planner eval model: ${subject.label}`);
    const invoke = (messages: BaseMessage[]) => createSubagent({
      model: subject.model,
      tools: [
        ...kanbanToolkit.tools.map(({ tool: declaredTool }) => declaredTool),
      ],
      promptSections: [{
        id: 'pet:planner',
        owner: 'planner',
        content: readFileSync(PET_PATH, 'utf8'),
      }, {
        id: 'capability:studio_planning',
        owner: 'studio_planning',
        content: capability.body,
      }],
      messages,
      maxIterations: 8,
    });
    let history: BaseMessage[] = [];
    const turns = [
      '帮我安排一个任务：任务列表的长标题会挤掉状态标签，需要修复展示并补齐回归测试。',
      '再加上窄屏布局的验证，还是放在同一个任务里。',
      '确认，就按修改后的草稿添加这一条任务。',
    ];
    for (const [index, request] of turns.entries()) {
      const result = await invoke([...history, new HumanMessage(request)]);
      const calls = countToolCalls(result.messages.slice(history.length));
      const snapshot = await service.readSnapshot();
      console.log(`Turn ${index + 1}: ${request}`);
      console.log(`Tool calls: ${calls.calls.map(({ name }) => name).join(' -> ') || '(none)'}`);
      console.log(`Response: ${result.output ?? '(empty)'}`);
      if (!result.output?.trim()) {
        throw new Error(`Turn ${index + 1}: missing natural final response.`);
      }
      if (index < 2) {
        if (snapshot.tasks.length !== 0 || snapshot.lastEventSequence !== 0
          || calls.calls.some(({ name }) => name !== 'kanban_task_list')) {
          throw new Error(`Turn ${index + 1}: mutated Kanban before confirmation.`);
        }
      } else {
        if (snapshot.tasks.length !== 1 || calls.count('kanban_task_add') !== 1
          || snapshot.tasks[0]?.assigneeId !== undefined || snapshot.relationships.length !== 0) {
          throw new Error('Confirmation must create exactly one unassigned task without relationships.');
        }
        console.log(`Created tasks: ${JSON.stringify(snapshot.tasks, null, 2)}`);
      }
      history = result.messages;
      console.log(`PASS turn ${index + 1}`);
    }
    console.log('PASS: Planner drafts, revises without writing, and creates only after user confirmation.');
  } finally {
    await service.close();
  }
}

await main();
