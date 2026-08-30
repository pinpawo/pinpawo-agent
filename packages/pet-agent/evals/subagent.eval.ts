// @ts-nocheck — eval script, types from langsmith barrel are incomplete
/**
 * LangSmith evaluation: subagent execution behavior.
 *
 * This evaluates the subagent directly with the configured real model and a
 * deterministic mock tool runtime. It checks whether the executor calls the
 * required tools, completes explicit multi-step tasks, and returns a usable
 * final response.
 *
 * Optional env vars:
 *   SUBAGENT_EVAL_PROFILE — model profile id; defaults to the configured profile
 *
 * Run:
 *   npm run eval:subagent -w @pinpawo/pet-agent
 */
import { tool } from '@langchain/core/tools';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createSubagent } from '../src/subagent/createSubagent';
import { materializeDelegation } from '../src/agent/orchestrator/delegation';
import { createDecisionEvalModel } from './scripts/decision-eval-model';
import { langfuseFetch, resolveLangfuseConfig } from './scripts/langfuse-api';
import { writeLangfuseEvalResult } from './scripts/langfuse-eval-writer';

const DATASET_NAME = 'subagent-execution';
const DATASET_DESCRIPTION = [
  'Evaluates Capability subagent execution against delegated task boundaries,',
  'tool evidence, continuation state, and truthful incomplete results.',
].join(' ');

const examples = [
  {
    name: 'read-file-and-summarize',
    inputs: {
      task: '请调用 view_file_chunk 读取 README.md，然后用一句话总结文件内容。',
      files: {
        'README.md': '# PinPawo\n\nPinPawo 是一个本地宠物助手项目，包含移动端、后端和本地 agent。',
      },
    },
    outputs: {
      expected_completion_reason: 'natural',
      expected_tools: ['view_file_chunk'],
      expected_tool_sequence: ['view_file_chunk'],
      expected_final_terms: ['PinPawo'],
      reason: 'Subagent should actually read the requested file before summarizing.',
    },
  },
  {
    name: 'multi-step-edit-and-lint',
    inputs: {
      task: [
        '请严格按顺序完成：',
        '1. 调用 view_file_chunk 读取 src/demo.ts。',
        '2. 把里面的 var 改成 const，并调用 write_file 写回 src/demo.ts。',
        '3. 调用 shell 运行 npm run lint。',
        '4. 最后用中文汇总修改和 lint 结果。',
      ].join('\n'),
      files: {
        'src/demo.ts': 'var count = 1;\nexport function demo() {\n  return count;\n}\n',
      },
      shell_outputs: {
        'npm run lint': 'lint passed, exit code 0',
      },
    },
    outputs: {
      expected_completion_reason: 'natural',
      expected_tools: ['view_file_chunk', 'write_file', 'shell'],
      expected_tool_sequence: ['view_file_chunk', 'write_file', 'shell'],
      expected_file_contains: { path: 'src/demo.ts', text: 'const count = 1' },
      expected_final_terms: ['lint'],
      reason: 'Subagent should complete both edit and verification steps before returning.',
    },
  },
  {
    name: 'web-search-summary',
    inputs: {
      task: '请调用 web_search 搜索 deepseek json_schema 支持情况，然后简短总结。',
      search_results: {
        'deepseek json_schema 支持情况': [
          'DeepSeek OpenAI-compatible API supports JSON output through response_format in selected modes.',
          'Structured output support can vary by model and provider endpoint.',
        ].join('\n'),
      },
    },
    outputs: {
      expected_completion_reason: 'natural',
      expected_tools: ['web_search'],
      expected_tool_sequence: ['web_search'],
      expected_final_terms: ['DeepSeek'],
      reason: 'Subagent should use the search tool when the task asks for external lookup.',
    },
  },
  {
    name: 'shell-failure-is-reported',
    inputs: {
      task: '请调用 shell 运行 npm test，然后告诉我测试是否通过。',
      shell_outputs: {
        'npm test': 'Error (exit 1):\n1 failing test in src/demo.test.ts',
      },
    },
    outputs: {
      expected_completion_reason: 'natural',
      expected_tools: ['shell'],
      expected_tool_sequence: ['shell'],
      expected_final_any_terms: ['失败', '未通过', '报错', 'failing', 'exit 1'],
      reason: 'Subagent should not claim success when the tool output reports a failing command.',
    },
  },
  {
    name: 'delegation-boundary-excludes-future-work',
    inputs: {
      main_context: '用户的完整目标是先读取 README.md，然后修改 src/demo.ts 并运行 npm test。',
      task: '只读取 README.md 并总结其中对 PinPawo 的介绍。',
      files: {
        'README.md': '# PinPawo\n\nPinPawo 是一个本地宠物助手项目。',
        'src/demo.ts': 'var count = 1;\n',
      },
    },
    outputs: {
      expected_completion_reason: 'natural',
      expected_tools: ['view_file_chunk'],
      forbidden_tools: ['write_file', 'shell'],
      expected_final_terms: ['PinPawo'],
      reason: 'Subagent should execute only the latest delegated task, not future work from main context.',
    },
  },
  {
    name: 'continuation-uses-existing-progress',
    inputs: {
      mode: 'continue',
      task: '完成版本和测试状态核验。',
      prior_task: '读取 package.json 的版本，然后运行 npm test。',
      prior_progress: '已读取 package.json，版本是 0.2.0；尚未运行测试。',
      gap_note: '只剩下 npm test 没有执行，请完成后交付版本和测试结果。',
      shell_outputs: {
        'npm test': 'tests passed, exit code 0',
      },
    },
    outputs: {
      expected_completion_reason: 'natural',
      expected_tools: ['shell'],
      forbidden_tools: ['view_file_chunk', 'write_file', 'web_search'],
      expected_final_terms: ['0.2.0'],
      expected_final_any_terms: ['passed', '通过'],
      reason: 'Continuation should preserve completed work and address only the stated gap.',
    },
  },
  {
    name: 'context-is-sufficient-without-tools',
    inputs: {
      task: '根据委派背景，直接说明当前发布通道。',
      essential_context: '已确认当前发布通道是 beta。',
    },
    outputs: {
      expected_completion_reason: 'natural',
      forbidden_tools: ['view_file_chunk', 'write_file', 'shell', 'web_search'],
      expected_final_terms: ['beta'],
      reason: 'Subagent should not call tools when the delegated evidence is already sufficient.',
    },
  },
  {
    name: 'missing-evidence-is-reported',
    inputs: {
      task: '读取 missing.txt 并报告文件内容。',
      files: {},
    },
    outputs: {
      expected_completion_reason: 'natural',
      expected_tools: ['view_file_chunk'],
      expected_final_any_terms: ['不存在', '找不到', '未找到', '失败', 'not found'],
      reason: 'Subagent should report the evidence gap instead of inventing file contents.',
    },
  },
];

const testCases = examples.map((example, index) => ({
  id: `subagent-execution-${String(index + 1).padStart(2, '0')}-${example.name}`,
  name: example.name,
  suite: 'subagent-execution',
  input: example.inputs,
  expected: example.outputs,
  tags: ['delegation_control'],
  metadata: {
    difficulty: index < 3 ? 'easy' : 'medium',
    reason: example.outputs.reason,
    source: 'subagent.eval.ts',
  },
}));

function readConfiguredDefaultProfileId(): string {
  try {
    const raw = readFileSync(resolve(homedir(), '.pinpawo', 'config.json'), 'utf8');
    const config = JSON.parse(raw) as {
      models?: { defaultProfileId?: unknown };
    };
    const profileId = config.models?.defaultProfileId;
    if (typeof profileId === 'string' && profileId.trim()) return profileId.trim();
    throw new Error('models.defaultProfileId is missing');
  } catch (error) {
    throw new Error(
      `Could not resolve the default model profile: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const profileId = process.env.SUBAGENT_EVAL_PROFILE ?? readConfiguredDefaultProfileId();
const evalSubject = createDecisionEvalModel({ profileId, role: 'subject' });

function normalizeToolName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readFinalText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content;
    if (typeof content === 'string' && content.trim()) {
      return content.trim();
    }
  }
  return '';
}

function buildMockTools(inputs: Record<string, unknown>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const files = new Map<string, string>(
    Object.entries(inputs.files && typeof inputs.files === 'object' ? inputs.files : {})
      .map(([path, content]) => [path, String(content)]),
  );
  const shellOutputs = inputs.shell_outputs && typeof inputs.shell_outputs === 'object'
    ? inputs.shell_outputs as Record<string, unknown>
    : {};
  const searchResults = inputs.search_results && typeof inputs.search_results === 'object'
    ? inputs.search_results as Record<string, unknown>
    : {};

  const viewFileChunkTool = tool(async ({ path, startLine, endLine }) => {
    calls.push({ name: 'view_file_chunk', args: { path, startLine, endLine } });
    const content = files.get(path);
    if (!content) return `Error: file not found: ${path}`;
    const lines = content.split('\n');
    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(lines.length, endLine ?? Math.min(start + 199, lines.length));
    return lines
      .slice(start - 1, end)
      .map((line, index) => `${start + index}: ${line}`)
      .join('\n');
  }, {
    name: 'view_file_chunk',
    description: '按行读取可读文本文件片段。',
    schema: z.object({
      path: z.string().describe('文件路径'),
      startLine: z.number().int().positive().optional().describe('起始行号'),
      endLine: z.number().int().positive().optional().describe('结束行号'),
    }),
  });

  const writeFileTool = tool(async ({ path, content }) => {
    calls.push({ name: 'write_file', args: { path, content } });
    files.set(path, content);
    return `已写入 ${path}`;
  }, {
    name: 'write_file',
    description: '写入内容到指定文件。',
    schema: z.object({
      path: z.string().describe('文件路径'),
      content: z.string().describe('完整文件内容'),
    }),
  });

  const shellTool = tool(async ({ command }) => {
    calls.push({ name: 'shell', args: { command } });
    const matchedOutput = shellOutputs[command]
      ?? Object.entries(shellOutputs).find(([expectedCommand]) => (
        command.includes(expectedCommand) || expectedCommand.includes(command)
      ))?.[1];
    if (matchedOutput !== undefined) return String(matchedOutput);

    const listedFiles = [...files.keys()].sort();
    const referencedFile = [...files.keys(), 'missing.txt']
      .find((path) => command.includes(path));
    if (/\b(?:ls|find|pwd)\b/.test(command)) {
      return [
        'cwd: /workspace',
        `files:\n${listedFiles.length > 0 ? listedFiles.join('\n') : '(empty)'}`,
        referencedFile && !files.has(referencedFile)
          ? `not found: ${referencedFile}`
          : null,
      ].filter(Boolean).join('\n');
    }
    if (/\bcat\b/.test(command) && referencedFile) {
      return files.get(referencedFile) ?? `Error (exit 1): ${referencedFile} not found`;
    }
    return `command passed: ${command}`;
  }, {
    name: 'shell',
    description: '在终端中执行命令并返回输出。',
    schema: z.object({ command: z.string().describe('要执行的命令') }),
  });

  const webSearchTool = tool(async ({ query }) => {
    calls.push({ name: 'web_search', args: { query } });
    return String(searchResults[query] ?? `搜索结果：${query}\n- mock result 1\n- mock result 2`);
  }, {
    name: 'web_search',
    description: '搜索外部信息并返回摘要结果。',
    schema: z.object({ query: z.string().describe('搜索 query') }),
  });

  return {
    tools: [viewFileChunkTool, writeFileTool, shellTool, webSearchTool],
    calls,
    readFile: (path: string) => files.get(path) ?? null,
  };
}

async function target(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runtime = buildMockTools(inputs);
  const task = String(inputs.task ?? '');
  const mode = inputs.mode === 'continue' ? 'continue' : 'initial';
  const briefing = materializeDelegation(mode === 'continue'
    ? {
        mode,
        userRequest: String(inputs.user_request ?? task),
        task,
        guidance: typeof inputs.gap_note === 'string' ? inputs.gap_note : null,
      }
    : {
        mode,
        userRequest: String(inputs.user_request ?? task),
        task,
        essentialContext: typeof inputs.essential_context === 'string'
          ? inputs.essential_context
          : null,
      });
  const mainContext = typeof inputs.main_context === 'string'
    ? inputs.main_context
    : `用户请求：${task}`;
  const messages: BaseMessage[] = [new HumanMessage(mainContext)];
  if (mode === 'continue' && typeof inputs.prior_progress === 'string') {
    const priorTask = typeof inputs.prior_task === 'string' ? inputs.prior_task : task;
    messages.push(materializeDelegation({
      mode: 'initial',
      userRequest: String(inputs.user_request ?? task),
      task: priorTask,
      essentialContext: null,
    }));
    messages.push(new AIMessage(inputs.prior_progress));
  }
  messages.push(briefing);
  const result = await createSubagent({
    model: evalSubject.model,
    tools: runtime.tools,
    promptSections: [],
    messages,
    maxIterations: 8,
  });

  return {
    completion_reason: result.completionReason,
    final_text: readFinalText(result.messages),
    called_tools: runtime.calls.map((call) => call.name),
    call_count: runtime.calls.length,
    calls: runtime.calls,
    files: {
      'src/demo.ts': runtime.readFile('src/demo.ts'),
      'README.md': runtime.readFile('README.md'),
    },
  };
}

function exactFieldEvaluator(field: string, expectedField: string) {
  return ({ outputs, referenceOutputs }) => {
    const expected = referenceOutputs?.[expectedField];
    if (typeof expected === 'undefined') {
      return { key: `${field}_correct`, score: 1, comment: `No ${expectedField} specified` };
    }
    const actual = outputs?.[field];
    return {
      key: `${field}_correct`,
      score: actual === expected ? 1 : 0,
      comment: actual === expected
        ? `Correct: ${String(actual)}`
        : `Expected ${field} ${String(expected)}, got ${String(actual)}`,
    };
  };
}

function requiredToolsEvaluator({ outputs, referenceOutputs }) {
  const expected = Array.isArray(referenceOutputs?.expected_tools)
    ? referenceOutputs.expected_tools.map(normalizeToolName).filter(Boolean)
    : [];
  const called = Array.isArray(outputs?.called_tools)
    ? outputs.called_tools.map(normalizeToolName).filter(Boolean)
    : [];
  const missing = expected.filter((name) => !called.includes(name));
  return {
    key: 'required_tools_called',
    score: missing.length === 0 ? 1 : 0,
    comment: missing.length === 0
      ? `Correct: called ${expected.join(', ')}`
      : `Missing required tools: ${missing.join(', ')}; called ${called.join(', ')}`,
  };
}

function forbiddenToolsEvaluator({ outputs, referenceOutputs }) {
  const forbidden = Array.isArray(referenceOutputs?.forbidden_tools)
    ? referenceOutputs.forbidden_tools.map(normalizeToolName).filter(Boolean)
    : [];
  const called = Array.isArray(outputs?.called_tools)
    ? outputs.called_tools.map(normalizeToolName).filter(Boolean)
    : [];
  const unexpected = forbidden.filter((name) => called.includes(name));
  return {
    key: 'forbidden_tools_avoided',
    score: unexpected.length === 0 ? 1 : 0,
    comment: unexpected.length === 0
      ? 'No out-of-scope tools were called'
      : `Called out-of-scope tools: ${unexpected.join(', ')}`,
  };
}

function toolSequenceEvaluator({ outputs, referenceOutputs }) {
  const expected = Array.isArray(referenceOutputs?.expected_tool_sequence)
    ? referenceOutputs.expected_tool_sequence.map(normalizeToolName).filter(Boolean)
    : [];
  if (expected.length === 0) {
    return { key: 'tool_sequence_correct', score: 1, comment: 'No expected sequence specified' };
  }

  const called = Array.isArray(outputs?.called_tools)
    ? outputs.called_tools.map(normalizeToolName).filter(Boolean)
    : [];
  let cursor = 0;
  for (const name of called) {
    if (name === expected[cursor]) cursor += 1;
    if (cursor >= expected.length) break;
  }

  return {
    key: 'tool_sequence_correct',
    score: cursor >= expected.length ? 1 : 0,
    comment: cursor >= expected.length
      ? `Correct sequence: ${expected.join(' -> ')}`
      : `Expected sequence ${expected.join(' -> ')}, called ${called.join(' -> ')}`,
  };
}

function finalTextNonEmptyEvaluator({ outputs }) {
  const finalText = typeof outputs?.final_text === 'string' ? outputs.final_text.trim() : '';
  return {
    key: 'final_text_non_empty',
    score: finalText.length > 0 ? 1 : 0,
    comment: finalText.length > 0 ? 'Final text is non-empty' : 'Final text is empty',
  };
}

function finalTermsEvaluator({ outputs, referenceOutputs }) {
  const expectedTerms = Array.isArray(referenceOutputs?.expected_final_terms)
    ? referenceOutputs.expected_final_terms.filter((item) => typeof item === 'string' && item.trim())
    : [];
  if (expectedTerms.length === 0) {
    return { key: 'final_terms_present', score: 1, comment: 'No expected terms specified' };
  }
  const finalText = typeof outputs?.final_text === 'string' ? outputs.final_text : '';
  const missing = expectedTerms.filter((term) => !finalText.toLowerCase().includes(term.toLowerCase()));
  return {
    key: 'final_terms_present',
    score: missing.length === 0 ? 1 : 0,
    comment: missing.length === 0
      ? `Correct: final text contains ${expectedTerms.join(', ')}`
      : `Missing terms ${missing.join(', ')} in final text: ${finalText}`,
  };
}

function finalAnyTermsEvaluator({ outputs, referenceOutputs }) {
  const expectedTerms = Array.isArray(referenceOutputs?.expected_final_any_terms)
    ? referenceOutputs.expected_final_any_terms.filter((item) => typeof item === 'string' && item.trim())
    : [];
  if (expectedTerms.length === 0) {
    return { key: 'final_any_terms_present', score: 1, comment: 'No expected any-terms specified' };
  }
  const finalText = typeof outputs?.final_text === 'string' ? outputs.final_text : '';
  const matched = expectedTerms.some((term) => finalText.toLowerCase().includes(term.toLowerCase()));
  return {
    key: 'final_any_terms_present',
    score: matched ? 1 : 0,
    comment: matched
      ? `Correct: final text contains one of ${expectedTerms.join(', ')}`
      : `Expected one of ${expectedTerms.join(', ')} in final text: ${finalText}`,
  };
}

function fileContainsEvaluator({ outputs, referenceOutputs }) {
  const expected = referenceOutputs?.expected_file_contains;
  if (!expected || typeof expected !== 'object') {
    return { key: 'file_contains_correct', score: 1, comment: 'No expected file assertion specified' };
  }
  const path = typeof expected.path === 'string' ? expected.path : '';
  const text = typeof expected.text === 'string' ? expected.text : '';
  const actual = outputs?.files && typeof outputs.files === 'object' ? outputs.files[path] : null;
  const passed = typeof actual === 'string' && actual.includes(text);
  return {
    key: 'file_contains_correct',
    score: passed ? 1 : 0,
    comment: passed
      ? `Correct: ${path} contains ${text}`
      : `Expected ${path} to contain ${text}; got ${String(actual)}`,
  };
}

const evaluators = [
  exactFieldEvaluator('completion_reason', 'expected_completion_reason'),
  requiredToolsEvaluator,
  forbiddenToolsEvaluator,
  toolSequenceEvaluator,
  finalTextNonEmptyEvaluator,
  finalTermsEvaluator,
  finalAnyTermsEvaluator,
  fileContainsEvaluator,
];

const scoreKeys = [
  'completion_reason_correct',
  'required_tools_called',
  'forbidden_tools_avoided',
  'tool_sequence_correct',
  'final_text_non_empty',
  'final_terms_present',
  'final_any_terms_present',
  'file_contains_correct',
];

async function syncDataset(config: ReturnType<typeof resolveLangfuseConfig>) {
  const list = await langfuseFetch<{ data?: Array<{ name: string }> }>(config, '/datasets');
  if (!(list.data?.some((dataset) => dataset.name === DATASET_NAME) ?? false)) {
    await langfuseFetch(config, '/datasets', {
      method: 'POST',
      body: JSON.stringify({
        name: DATASET_NAME,
        description: DATASET_DESCRIPTION,
        metadata: { owner: 'pet-agent', areas: ['delegation_control'] },
      }),
    });
  }

  for (const testCase of testCases) {
    await langfuseFetch(config, '/dataset-items', {
      method: 'POST',
      body: JSON.stringify({
        id: testCase.id,
        datasetName: DATASET_NAME,
        input: testCase.input,
        expectedOutput: testCase.expected,
        metadata: {
          name: testCase.name,
          suite: testCase.suite,
          tags: testCase.tags,
          ...testCase.metadata,
        },
      }),
    });
  }
}

async function main() {
  const config = resolveLangfuseConfig();
  await syncDataset(config);
  const runName = process.env.LANGFUSE_RUN_NAME
    ?? `subagent-execution-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`Running Langfuse subagent eval: ${runName}`);
  console.log(`Dataset: ${DATASET_NAME}`);
  console.log(`Subagent model: ${evalSubject.label}`);
  console.log(`Langfuse: ${config.baseUrl}`);
  console.log(`Cases: ${testCases.length}\n`);

  const rows = [];
  for (const testCase of testCases) {
    const started = performance.now();
    try {
      const output = await target(testCase.input);
      const scores = evaluators.map((evaluator) => evaluator({
        outputs: output,
        referenceOutputs: testCase.expected,
      }));
      const ok = scores.every(({ score }) => score === 1);
      const durationMs = Math.round(performance.now() - started);
      await writeLangfuseEvalResult({
        config,
        datasetName: DATASET_NAME,
        runName,
        traceName: 'subagent-execution-eval',
        testCase,
        output,
        scores,
        durationMs,
        metadata: {
          subjectModelProfileId: evalSubject.metadata.profileId,
          subjectModelProfileFingerprint: evalSubject.metadata.fingerprint,
        },
      });
      rows.push({ testCase, output, scores, ok, durationMs });
      console.log(`[${ok ? 'PASS' : 'FAIL'}] ${testCase.name} (${durationMs}ms)`);
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const scores = [{ key: 'run_error', score: 0, comment: message.slice(0, 800) }];
      await writeLangfuseEvalResult({
        config,
        datasetName: DATASET_NAME,
        runName,
        traceName: 'subagent-execution-eval',
        testCase,
        output: {},
        scores,
        durationMs,
        error: message,
        metadata: {
          subjectModelProfileId: evalSubject.metadata.profileId,
          subjectModelProfileFingerprint: evalSubject.metadata.fingerprint,
        },
      });
      rows.push({ testCase, output: {}, scores, ok: false, durationMs, error: message });
      console.log(`[ERROR] ${testCase.name} (${durationMs}ms): ${message}`);
    }
  }

  console.log('\n=== Evaluation complete ===');
  console.log(`Cases: ${rows.filter((row) => row.ok).length}/${rows.length} passed`);
  for (const key of scoreKeys) {
    const scores = rows.flatMap((row) => row.scores.filter((item) => item.key === key));
    const passed = scores.filter((item) => item.score === 1).length;
    console.log(`${key}: ${passed}/${scores.length} passed, ${scores.length - passed} failed.`);
  }
  for (const row of rows) {
    const failedScores = row.scores.filter((item) => item.score !== 1);
    if (failedScores.length === 0) continue;
    console.log(`  - ${row.testCase.name}: ${failedScores.map((item) => item.comment).join(' | ')}`);
  }
  console.log('View results in Langfuse.');
  if (rows.some((row) => !row.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
