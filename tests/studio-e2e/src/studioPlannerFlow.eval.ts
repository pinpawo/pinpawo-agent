/** Full model-driven Planner graph over an isolated synthetic project and in-memory Kanban. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import {
  buildOrchestratorRunInput, compileAgentRegistry, createOrchestratorGraph,
  definePetDocument, petDocumentSystemPromptSection, readCapabilityExecutions,
} from '@pinpawo/pet-agent';
import { createInMemoryKanbanTaskService, createKanbanPlanningToolkit } from '@pinpawo-plugin/kanban';
import { loadCapabilityDirectory } from 'pinpawo/host-runtime';
import { createProjectInspectionToolkit } from '../../../services/local-agent/src/toolkits/local';
import { bindToolkitRuntime } from '../../../services/local-agent/src/toolkits/runtimeBinding';
import { connectHostRuntimes } from '../../../services/local-agent/src/runtimeService/hostClient';
import { createStudioContextToolkit } from '../../../packages/studio/src/host/studioContextToolkit';
import { createDecisionEvalModel } from '../../../packages/pet-agent/evals/scripts/decision-eval-model';

const template = resolve(import.meta.dirname, '../../../packages/studio/templates/default/pets/planner');
const config = JSON.parse(await readFile(resolve(homedir(), '.pinpawo/config.json'), 'utf8')) as { models?: { defaultProfileId?: string } };
const profileId = process.env.STUDIO_PLANNING_EVAL_PROFILE ?? config.models?.defaultProfileId;
assert.ok(profileId, 'A configured model profile is required');
const subject = createDecisionEvalModel({ profileId, role: 'subject' });
console.log(`Studio Planner flow model: ${subject.label}`);
const root = await mkdtemp(join(tmpdir(), 'studio-planner-model-e2e-'));
const service = createInMemoryKanbanTaskService();
let runtimeConnection: Awaited<ReturnType<typeof connectHostRuntimes>> | undefined;
await service.init();

try {
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'README.md'), '# Task board\nTask titles and status badges share one flex row in src/task.css. Long titles push badges out of view.\n');
  await writeFile(join(root, 'src/task.css'), '.task { display: flex; }\n.title { white-space: nowrap; }\n');
  const original = await readFile(join(root, 'src/task.css'), 'utf8');
  const loaded = await loadCapabilityDirectory(join(template, 'capabilities'));
  const capabilities = loaded.map(({ capability }) => capability);
  const toolkits = [createProjectInspectionToolkit(), createKanbanPlanningToolkit(service),
    createStudioContextToolkit(() => ['planner', 'executor', 'reviewer', 'wiki'].map((petId) => ({ petId, name: petId })))];
  runtimeConnection = await connectHostRuntimes({ toolkits });
  const registry = compileAgentRegistry({ capabilities, toolkits: toolkits.map(toolkit => bindToolkitRuntime(toolkit, runtimeConnection!.bindings[toolkit.name])) });
  assert.equal(registry.capabilities.length, 2, 'Both production Planner capabilities must compile');
  const graph = createOrchestratorGraph({
    models: { act: subject.model, subagent: subject.model }, defaultCapabilityName: 'studio_planning',
    checkpoint: new MemorySaver(),
  });
  const calls: Array<{ name: string; input: string }> = [];
  const turns = [
    '请只读探索当前项目的 README.md 和 src/task.css，查明长标题挤掉状态标签的问题，给出修复和窄屏验证的任务草稿。先查询当前 Studio 有哪些 Pet，说明后续代码实现、审阅和 Wiki 整理如何交接。这一轮先给我草稿，不要创建 Kanban 任务，也不要修改项目文件。',
    '确认刚才的任务草稿，请现在创建相应的 Kanban 任务，保留为未分配，任务详情带上来源和完成标准。后续我会在 Console 选择执行者，这次不需要执行实现、审阅或写 Wiki。',
  ];
  for (const [index, request] of turns.entries()) {
    const result = await graph.invoke(buildOrchestratorRunInput([new HumanMessage(request)]), {
      context: { workdir: root, systemPromptSections: [{ id: 'host:workdir', content: root }, petDocumentSystemPromptSection(definePetDocument({ content: await readFile(join(template, 'PET.md'), 'utf8') }))] },
      configurable: { thread_id: 'studio-planner-flow', registry, globalReviewPolicy: { mode: 'full_access' } },
      recursionLimit: 100,
      signal: AbortSignal.timeout(300_000),
      callbacks: [{ handleToolStart(serialized, input, _runId, _parent, _tags, _metadata, runName) {
        const name = runName ?? serialized.name ?? serialized.id.at(-1) ?? '';
        calls.push({ name, input });
        console.log(`tool: ${name}`);
      } }],
    });
    const snapshot = await service.readSnapshot();
    console.log(JSON.stringify({ turn: index + 1, calls: calls.map(({ name }) => name), reply: result.messages.at(-1)?.text }));
    const executions = readCapabilityExecutions(result.messages);
    const last = result.messages.at(-1);
    assert.ok(last && AIMessage.isInstance(last) && last.text.trim(), 'The run must end with a natural reply');
    assert.ok(executions.every(({ execution }) => ['studio_exploration', 'studio_planning'].includes(execution.capability)));
    if (index === 0) {
      assert.equal(snapshot.tasks.length, 0, 'Draft must not mutate Kanban');
      assert.ok(executions.some(({ execution }) => execution.capability === 'studio_exploration'), 'Read-only exploration must actually execute');
      assert.ok(calls.some(({ name }) => name === 'studio_pet_list'), 'Discovery must use the real directory tool');
      assert.ok(calls.some(({ name }) => ['read_file', 'view_file_chunk'].includes(name)), 'Exploration must read project evidence');
    } else {
      assert.ok(snapshot.tasks.length > 0, 'Confirmed tasks must reach Kanban');
      assert.ok(snapshot.tasks.every((task) => task.assigneeId === undefined && task.status === 'todo'));
      assert.ok(snapshot.tasks.every((task) => task.detail.trim().length > 0));
    }
    assert.equal(await readFile(join(root, 'src/task.css'), 'utf8'), original);
    assert.deepEqual((await readdir(root)).sort(), ['README.md', 'src']);
    console.log(JSON.stringify({ turn: index + 1, tasks: snapshot.tasks.length,
      capabilities: executions.map(({ execution }) => execution.capability) }));
  }
  console.log('PASS: full Planner graph discovers Pets, explores evidence, drafts, and creates unassigned tasks after confirmation.');
} finally {
  try {
    await runtimeConnection?.close();
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}
