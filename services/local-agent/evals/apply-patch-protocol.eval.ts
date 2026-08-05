/**
 * Live model evaluation for apply_patch protocol selection.
 *
 * The subject model sees the real tool schema and description. The task does
 * not name a patch protocol, so format selection belongs to the model.
 *
 * Run:
 *   npm run eval:apply-patch -w pinpawo
 *
 * Optional:
 *   PINPAWO_APPLY_PATCH_EVAL_PROFILE=<profile-id>
 *   PINPAWO_APPLY_PATCH_EVAL_REPEATS=<positive integer>
 */
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createSubagent } from '@pinpawo/pet-agent';
import { buildLocalAgentModels } from '../src/agentModels';
import { buildLocalModelProfileRegistry } from '../src/llmConfig';
import { parsePatchDocument, type PatchFormat } from '../src/toolkits/local/applyPatch';
import { applyPatchTool, viewFileChunkTool } from '../src/toolkits/local/fileTools';
import { getLocalToolsWorkdir, setLocalToolsWorkdir } from '../src/toolkits/local/pathUtils';

type Scenario = {
  name: string;
  initial: string;
  expected: string;
  instruction: string;
};

type RecordedPatchCall = {
  declaredFormat: unknown;
  detectedFormat: PatchFormat | null;
  formatMatches: boolean | null;
  ok: boolean;
  errorCode: unknown;
};

const scenarios: Scenario[] = [
  {
    name: 'single-update',
    initial: 'alpha\nbeta\ngamma\n',
    expected: 'alpha\nBETA\ngamma\n',
    instruction: '把第二行 beta 改成 BETA。',
  },
  {
    name: 'two-separated-updates',
    initial: 'first\nkeep one\nmiddle\nkeep two\nlast\n',
    expected: 'FIRST\nkeep one\nmiddle\nkeep two\nLAST\n',
    instruction: '把 first 改成 FIRST，并把 last 改成 LAST。',
  },
  {
    name: 'indent-sensitive-update',
    initial: 'function run() {\n  if (ready) {\n    return 1;\n  }\n}\n',
    expected: 'function run() {\n  if (ready) {\n    return 2;\n  }\n}\n',
    instruction: '把 return 1 改成 return 2，并保持现有缩进。',
  },
  {
    name: 'duplicate-context-update',
    initial: 'section one\nvalue=old\nend one\nsection two\nvalue=old\nend two\n',
    expected: 'section one\nvalue=old\nend one\nsection two\nvalue=new\nend two\n',
    instruction: '只把 section two 中的 value=old 改成 value=new，不要修改 section one。',
  },
  {
    name: 'insert-and-delete-lines',
    initial: 'header\nobsolete\nkeep\nfooter\n',
    expected: 'header\nkeep\ninserted\nfooter\n',
    instruction: '删除 obsolete，并在 keep 后新增一行 inserted。',
  },
  {
    name: 'protocol-marker-as-content',
    initial: 'before\n*** Begin Patch\nafter\n',
    expected: 'before\nordinary content\nafter\n',
    instruction: '把中间一行的 *** Begin Patch 改成 ordinary content。',
  },
];

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function messageContentText(message: BaseMessage) {
  return typeof message.content === 'string' ? message.content : '';
}

function readJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function recordPatchCalls(messages: BaseMessage[]): RecordedPatchCall[] {
  const outputs = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    if (message._getType() !== 'tool') continue;
    const toolCallId = (message as BaseMessage & { tool_call_id?: string }).tool_call_id;
    const output = readJsonRecord(messageContentText(message));
    if (toolCallId && output) outputs.set(toolCallId, output);
  }

  const calls: RecordedPatchCall[] = [];
  for (const message of messages) {
    if (message._getType() !== 'ai') continue;
    const toolCalls = (message as BaseMessage & {
      tool_calls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>;
    }).tool_calls ?? [];
    for (const call of toolCalls) {
      if (call.name !== 'apply_patch') continue;
      const declaredFormat = call.args?.format;
      const patch = call.args?.patch;
      let detectedFormat: PatchFormat | null = null;
      if (typeof patch === 'string') {
        try {
          detectedFormat = parsePatchDocument(patch).format;
        } catch {
          detectedFormat = null;
        }
      }
      const output = call.id ? outputs.get(call.id) : undefined;
      calls.push({
        declaredFormat,
        detectedFormat,
        formatMatches: detectedFormat === null ? null : declaredFormat === detectedFormat,
        ok: output?.ok === true,
        errorCode: output?.code,
      });
    }
  }
  return calls;
}

const profileRegistry = buildLocalModelProfileRegistry();
const profileId = process.env.PINPAWO_APPLY_PATCH_EVAL_PROFILE?.trim() || undefined;
const llmConfig = profileRegistry.resolve(profileId);
const model = buildLocalAgentModels(llmConfig).subagent;
const repeats = readPositiveInteger(process.env.PINPAWO_APPLY_PATCH_EVAL_REPEATS, 1);
const results = [];
const originalCwd = process.cwd();
const originalToolsWorkdir = getLocalToolsWorkdir();

for (let repeat = 1; repeat <= repeats; repeat += 1) {
  for (const scenario of scenarios) {
    const root = mkdtempSync(resolve(tmpdir(), 'pinpawo-apply-patch-eval-'));
    const path = resolve(root, 'sample.txt');
    try {
      process.chdir(root);
      setLocalToolsWorkdir(root);
      writeFileSync(path, scenario.initial, 'utf-8');
      const result = await createSubagent({
        model,
        tools: [viewFileChunkTool, applyPatchTool],
        promptSections: [{
          id: 'apply-patch-eval',
          owner: 'eval',
          content: '先读取目标文件，再使用 apply_patch 完成修改；工具成功后简短汇报。',
        }],
        messages: [new HumanMessage(`${scenario.instruction}\n文件路径：sample.txt`)],
        maxIterations: 8,
        contextWindowTokens: llmConfig.contextWindowTokens,
      });
      const calls = recordPatchCalls(result.messages);
      results.push({
        scenario: scenario.name,
        repeat,
        success: readFileSync(path, 'utf-8') === scenario.expected,
        attempts: calls.length,
        retries: Math.max(0, calls.length - 1),
        firstAttemptSucceeded: calls[0]?.ok === true,
        formats: calls.map((call) => call.declaredFormat),
        formatMatches: calls.every((call) => call.formatMatches !== false),
        calls,
        completionReason: result.completionReason,
      });
    } finally {
      process.chdir(originalCwd);
      setLocalToolsWorkdir(originalToolsWorkdir);
      rmSync(root, { recursive: true, force: true });
    }
  }
}

const successful = results.filter((result) => result.success).length;
const firstAttemptSuccesses = results.filter((result) => result.firstAttemptSucceeded).length;
const report = {
  modelProfileId: llmConfig.modelProfileId,
  model: llmConfig.model,
  cases: results.length,
  successRate: successful / results.length,
  firstAttemptSuccessRate: firstAttemptSuccesses / results.length,
  totalRetries: results.reduce((total, result) => total + result.retries, 0),
  results,
};

console.log(JSON.stringify(report, null, 2));
if (successful !== results.length || results.some((result) => !result.formatMatches)) {
  process.exitCode = 1;
}
