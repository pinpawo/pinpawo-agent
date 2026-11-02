import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createToolDeliverables, type Deliverable } from '@pinpawo/agent-contracts';
import {
  buildOrchestratorRunInput,
  buildReviewSpec,
  compileAgentRegistry,
  createOrchestratorGraph,
  defineInstructionDocument,
  readCapabilityExecutions,
} from '@pinpawo/pet-agent';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import { FileSaver } from './fileSaver';

type Phase = 'pause' | 'resume' | 'reopen';
type Report = { pid: number; effects: string[]; deliverables: Deliverable[]; executions: number; modelCalls: number };
const first = { uri: 'artifact://fixture/first', title: 'First report' };
const reviewed = { uri: 'artifact://fixture/reviewed', title: 'Reviewed report' };
const runChild = promisify(execFile);

function call(name: string, args: Record<string, unknown>, id: string) {
  return new AIMessage({ content: '', tool_calls: [{ name, args, id }] });
}

async function worker(phase: Phase, root: string) {
  let modelCalls = 0;
  class SequenceModel extends BaseChatModel {
    private index = 0;
    constructor(private readonly replies: AIMessage[]) { super({}); }
    _llmType() { return 'filesaver-deliverables-sequence'; }
    bindTools() { return this; }
    async _generate() {
      modelCalls++;
      const message = this.replies[this.index++];
      assert.ok(message, `unexpected model call during ${phase}`);
      return { generations: [{ message, text: message.text }] };
    }
  }
  class PublishingModel extends BaseChatModel {
    _llmType() { return 'filesaver-deliverables-publisher'; }
    bindTools() { return this; }
    async _generate(messages: BaseMessage[]) {
      modelCalls++;
      assert.notEqual(phase, 'reopen', 'a completed run must not call the model again');
      const results = messages.filter(ToolMessage.isInstance);
      const message = !results.some(value => value.tool_call_id === 'publish-first')
        ? call('publish_first', {}, 'publish-first')
        : !results.some(value => value.tool_call_id === 'publish-reviewed')
          ? call('publish_reviewed', {}, 'publish-reviewed')
          : new AIMessage('Both reports are ready.');
      return { generations: [{ message, text: message.text }] };
    }
  }
  const effectsPath = join(root, 'effects.txt');
  const publishFirst = tool(() => {
    appendFileSync(effectsPath, 'first\n');
    return ['First report published.', createToolDeliverables([first])];
  }, { name: 'publish_first', description: 'Publish the first report.', schema: z.object({}), responseFormat: 'content_and_artifact' });
  const publishReviewed = tool(() => {
    appendFileSync(effectsPath, 'reviewed\n');
    return ['Reviewed report published.', createToolDeliverables([reviewed])];
  }, { name: 'publish_reviewed', description: 'Publish the reviewed report.', schema: z.object({}), responseFormat: 'content_and_artifact' });
  const registry = compileAgentRegistry({
    toolkits: [{ name: 'reports', description: 'Publish reports.', tools: [
      { tool: publishFirst },
      { tool: publishReviewed, review: { request: () => buildReviewSpec({
        view: { kind: 'plain', body: 'Publish the second report?' },
        options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
      }) } },
    ] }],
    capabilities: [{ name: 'general', description: 'Publish reports.', uses: ['reports'],
      instructions: defineInstructionDocument({ content: 'Publish the two requested reports.' }) }],
  });
  const saver = new FileSaver(join(root, 'checkpoints-capability-v6.json'));
  saver.acquireHostWriterLease(`deliverables-${process.pid}`);
  try {
    const graph = createOrchestratorGraph({
      checkpoint: saver,
      models: {
        answer: new SequenceModel(phase === 'pause'
          ? [call('plan_request', { goal: 'Publish both reports.' }, 'entry')] : []),
        act: new SequenceModel(phase === 'pause' ? [
          call('submit_plan', { tasks: [{ capability: 'general', objective: 'Publish both reports.' }] }, 'plan'),
          call('delegate_capability', { briefing: 'Publish the first report, then request approval for the second.' }, 'delegate'),
        ] : phase === 'resume' ? [
          call('review_current', { completed: true, reason: 'Both publications were verified.' }, 'accept'),
          new AIMessage('Reports complete.'),
        ] : []),
        subagent: new PublishingModel({}),
      },
    });
    const config = { configurable: {
      thread_id: 'deliverables-process-recovery', registry,
      reviewCapabilities: { humanReview: true, sessionAuthorization: false },
      globalReviewPolicy: { mode: 'require_authorization' },
    } };
    const effects = () => readFileSync(effectsPath, 'utf8').trim().split('\n');
    if (phase !== 'pause') {
      const saved = await graph.getState(config);
      if (phase === 'resume') {
        assert.ok(saved.tasks.some(task => task.interrupts?.length));
        assert.deepEqual(effects(), ['first']);
        let childReferences: unknown;
        for await (const tuple of saver.list(config)) {
          if (tuple.config.configurable?.checkpoint_ns?.startsWith('capability:')
            && Array.isArray(tuple.checkpoint.channel_values.deliverables)
            && tuple.checkpoint.channel_values.deliverables.length) {
            childReferences = tuple.checkpoint.channel_values.deliverables;
          }
        }
        assert.deepEqual(childReferences, [first], 'the new process restores child collector state from disk before resuming');
      } else {
        const executions = readCapabilityExecutions(saved.values.messages);
        assert.equal(executions.length, 1);
        assert.deepEqual(executions[0].result.deliverables, [first, reviewed]);
      }
    }
    const output = phase === 'pause'
      ? await graph.invoke(buildOrchestratorRunInput([new HumanMessage('Publish both reports.')]), config)
      : await graph.invoke(phase === 'resume' ? new Command({ resume: { decisions: [{
        reviewId: 'tool-review:publish_reviewed:publish-reviewed', selectedOptionId: 'approve',
      }] } }) : null, config);
    const executions = readCapabilityExecutions(output.messages);
    const saved = await graph.getState(config);
    if (phase === 'pause') {
      assert.ok(saved.tasks.some(task => task.interrupts?.length));
      assert.deepEqual(effects(), ['first']);
      assert.equal(executions.length, 0);
    } else {
      assert.deepEqual(saved.next, []);
      assert.deepEqual(effects(), ['first', 'reviewed']);
      assert.equal(executions.length, 1);
      assert.deepEqual(executions[0].result.deliverables, [first, reviewed]);
      assert.equal(executions[0].result.status, 'returned');
      assert.deepEqual(readCapabilityExecutions(saved.values.messages)[0].result.deliverables, [first, reviewed]);
    }
    const report: Report = { pid: process.pid, effects: effects(), executions: executions.length,
      deliverables: executions[0]?.result.deliverables ?? [], modelCalls };
    writeFileSync(join(root, `${phase}.json`), JSON.stringify(report));
  } finally {
    saver.releaseHostWriterLease();
  }
}

if (process.argv[2] === '--deliverables-worker') {
  const phase = process.argv[3];
  const root = process.argv[4];
  assert.ok(phase === 'pause' || phase === 'resume' || phase === 'reopen');
  assert.ok(root);
  await worker(phase, root);
} else {
  test('FileSaver restores Capability deliverables across independent process exits without repeating tools', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'pinpawo-deliverables-process-'));
    try {
      const reports: Report[] = [];
      for (const phase of ['pause', 'resume', 'reopen'] as const) {
        // Await process exit before starting the next reader. No models, saver
        // instances or credential-bearing environment are shared across phases.
        await runChild(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url), '--deliverables-worker', phase, root], {
          cwd: fileURLToPath(new URL('../../../', import.meta.url)),
          env: { PATH: process.env.PATH, LANGCHAIN_TRACING_V2: 'false', LANGFUSE_TRACING_ENABLED: 'false' },
          timeout: 20_000,
        });
        reports.push(JSON.parse(readFileSync(join(root, `${phase}.json`), 'utf8')) as Report);
      }
      assert.equal(new Set(reports.map(report => report.pid)).size, 3);
      assert.ok(reports.every(report => report.pid !== process.pid));
      assert.deepEqual(reports.map(report => report.effects), [['first'], ['first', 'reviewed'], ['first', 'reviewed']]);
      assert.deepEqual(reports.map(report => report.executions), [0, 1, 1]);
      assert.deepEqual(reports[1].deliverables, [first, reviewed]);
      assert.deepEqual(reports[2].deliverables, [first, reviewed]);
      assert.equal(reports[2].modelCalls, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
