// @ts-nocheck — eval script, types from langsmith barrel are incomplete
/**
 * LangSmith evaluation: subagent execution behavior.
 *
 * This evaluates the subagent directly with the configured real model and a
 * deterministic mock tool runtime. It checks whether the executor calls the
 * required tools, completes explicit multi-step tasks, and returns a usable
 * final response.
 *
 * Required env vars:
 *   LANGCHAIN_API_KEY     — LangSmith API key
 *   LANGCHAIN_TRACING_V2  — set to "true" to enable tracing
 *   LLM_API_KEY           — model provider API key
 *   LLM_BASE_URL          — model provider base URL
 *   LLM_MODEL             — model name
 *
 * Run:
 *   npm run eval:subagent -w @pinpawo/pet-agent
 */
import { tool } from '@langchain/core/tools';
import { HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { Client } from 'langsmith';
import { evaluate } from 'langsmith/evaluation';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createSubagent } from '../src/subagent/createSubagent';

const DATASET_NAME = 'subagent-execution';

const examples = [
  {
    name: 'read-file-and-summarize',
    inputs: {
      task: '请调用 read_file 读取 README.md，然后用一句话总结文件内容。',
      files: {
        'README.md': '# PinPawo\n\nPinPawo 是一个本地宠物助手项目，包含移动端、后端和本地 agent。',
      },
    },
    outputs: {
      expected_completion_reason: 'natural',
      expected_tools: ['read_file'],
      expected_tool_sequence: ['read_file'],
      expected_final_terms: ['PinPawo'],
      reason: 'Subagent should actually read the requested file before summarizing.',
    },
  },
  {
    name: 'multi-step-edit-and-lint',
    inputs: {
      task: [
        '请严格按顺序完成：',
        '1. 调用 read_file 读取 src/demo.ts。',
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
      expected_tools: ['read_file', 'write_file', 'shell'],
      expected_tool_sequence: ['read_file', 'write_file', 'shell'],
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
];

function loadPinpetConfig(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(homedir(), '.pinpawo', 'config.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const pinpawoConfig = loadPinpetConfig();
const LLM_API_KEY = process.env.LLM_API_KEY || pinpawoConfig.llm_api_key;
const LLM_BASE_URL = process.env.LLM_BASE_URL || pinpawoConfig.llm_base_url || 'https://api.deepseek.com';
const LLM_MODEL = process.env.LLM_MODEL || pinpawoConfig.llm_model || 'deepseek-v4-pro';

if (!LLM_API_KEY) {
  console.error('Missing LLM_API_KEY — set env var or configure ~/.pinpawo/config.json');
  process.exit(1);
}

function buildModel() {
  const normalizedModel = LLM_MODEL.toLowerCase();
  const modelKwargs = normalizedModel.includes('qwen') || normalizedModel.includes('glm')
    ? { extra_body: { enable_thinking: false } }
    : normalizedModel.includes('deepseek')
      ? { thinking: { type: 'disabled' } }
      : undefined;

  return new ChatOpenAI({
    model: LLM_MODEL,
    temperature: 0.2,
    timeout: 180_000,
    apiKey: LLM_API_KEY,
    modelKwargs,
    configuration: {
      baseURL: LLM_BASE_URL,
      defaultHeaders: { Authorization: `Bearer ${LLM_API_KEY}` },
    },
  });
}

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

  const readFileTool = tool(async ({ path }) => {
    calls.push({ name: 'read_file', args: { path } });
    const content = files.get(path);
    return content ?? `Error: file not found: ${path}`;
  }, {
    name: 'read_file',
    description: '读取指定文件的内容。',
    schema: z.object({ path: z.string().describe('文件路径') }),
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
    return String(matchedOutput ?? `command passed: ${command}`);
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
    tools: [readFileTool, writeFileTool, shellTool, webSearchTool],
    calls,
    readFile: (path: string) => files.get(path) ?? null,
  };
}

async function target(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runtime = buildMockTools(inputs);
  const result = await createSubagent({
    model: buildModel(),
    tools: runtime.tools,
    instructions: [
      '你可以使用工具完成任务。',
      '用户明确要求调用工具时，必须实际调用对应工具，不要假装已经执行。',
      '多步骤任务必须等所有步骤完成并核验后再返回。',
    ],
    messages: [new HumanMessage(String(inputs.task ?? ''))],
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

async function ensureDataset() {
  const client = new Client();
  try {
    const existing = await client.readDataset({ datasetName: DATASET_NAME });
    if (existing) {
      await client.deleteDataset({ datasetId: existing.id });
    }
  } catch {}

  const dataset = await client.createDataset(DATASET_NAME, {
    description: 'Evaluates subagent tool execution behavior with a real model and deterministic mock tools.',
  });
  for (const example of examples) {
    await client.createExample({
      dataset_id: dataset.id,
      inputs: example.inputs,
      outputs: example.outputs,
      metadata: { name: example.name },
    });
  }
}

async function main() {
  await ensureDataset();
  console.log(`Running subagent execution evaluation against "${DATASET_NAME}"...`);
  console.log(`Subagent model: ${LLM_MODEL} @ ${LLM_BASE_URL}`);
  console.log('');

  const results = await evaluate(target, {
    data: DATASET_NAME,
    evaluators: [
      exactFieldEvaluator('completion_reason', 'expected_completion_reason'),
      requiredToolsEvaluator,
      toolSequenceEvaluator,
      finalTextNonEmptyEvaluator,
      finalTermsEvaluator,
      finalAnyTermsEvaluator,
      fileContainsEvaluator,
    ],
    experimentPrefix: 'subagent-execution',
    maxConcurrency: 1,
  });

  const rows = results.results;
  const keys = [
    'completion_reason_correct',
    'required_tools_called',
    'tool_sequence_correct',
    'final_text_non_empty',
    'final_terms_present',
    'final_any_terms_present',
    'file_contains_correct',
  ];

  console.log('\n=== Evaluation complete ===');
  for (const key of keys) {
    const scores = rows.flatMap((row) => row.evaluationResults.results.filter((item) => item.key === key));
    const passed = scores.filter((item) => item.score === 1).length;
    console.log(`${key}: ${passed}/${scores.length} passed, ${scores.length - passed} failed.`);
  }
  for (const row of rows) {
    const failedScores = row.evaluationResults.results.filter((item) => keys.includes(item.key) && item.score !== 1);
    if (failedScores.length === 0) continue;
    console.log(`  - ${row.example.metadata?.name ?? row.example.id}: ${failedScores.map((item) => item.comment).join(' | ')}`);
  }
  console.log('View results in LangSmith dashboard.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
