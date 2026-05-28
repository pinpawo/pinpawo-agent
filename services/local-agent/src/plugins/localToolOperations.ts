import { createOperationRegistry, type OperationMetadata } from '../events/operationRegistry';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === 'number' ? value : undefined;
}

function readBoolean(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return readRecord(value);
  try {
    return readRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function pathInputSummary(input: unknown) {
  const record = readRecord(input);
  const target = readString(record, 'path');
  return target ? { target } : null;
}

function sourceDestinationInputSummary(input: unknown) {
  const record = readRecord(input);
  const source = readString(record, 'source');
  const destination = readString(record, 'destination');
  return source || destination
    ? { target: destination ?? source, details: { source, destination } }
    : null;
}

function okOutputPathSummary(output: unknown, pathField = 'path') {
  const record = readJsonRecord(output);
  const target = readString(record, pathField);
  return target ? { target } : null;
}

const localToolOperations: Record<string, OperationMetadata> = {
  read_file: {
    kind: 'file.read',
    title: '读文件',
    summarizeInput: pathInputSummary,
  },
  view_file_chunk: {
    kind: 'file.chunk.read',
    title: '看片段',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'path');
      const startLine = readNumber(record, 'startLine');
      const endLine = readNumber(record, 'endLine');
      return target ? { target, details: { startLine, endLine } } : null;
    },
  },
  stat_path: {
    kind: 'file.stat',
    title: '看属性',
    summarizeInput: pathInputSummary,
  },
  write_file: {
    kind: 'file.write',
    title: '写文件',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'path');
      return target
        ? { target, summary: readBoolean(record, 'append') ? 'append' : 'write' }
        : null;
    },
    summarizeOutput: (output) => okOutputPathSummary(output),
  },
  update_file: {
    kind: 'file.update',
    title: '改文件',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'path');
      return target
        ? { target, summary: readBoolean(record, 'replaceAll') ? 'replace_all' : 'replace' }
        : null;
    },
    summarizeOutput: (output) => okOutputPathSummary(output),
  },
  multi_edit: {
    kind: 'file.multi_edit',
    title: '批量修改',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'path');
      const rawEdits = record?.edits;
      const edits = Array.isArray(rawEdits) ? rawEdits.length : undefined;
      return target ? { target, details: { edits } } : null;
    },
    summarizeOutput: (output) => okOutputPathSummary(output),
  },
  apply_file_patch: {
    kind: 'file.patch',
    title: '应用补丁',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'path');
      const rawHunks = record?.hunks;
      const hunks = Array.isArray(rawHunks) ? rawHunks.length : undefined;
      return target ? { target, details: { hunks } } : null;
    },
    summarizeOutput: (output) => okOutputPathSummary(output),
  },
  apply_unified_patch: {
    kind: 'patch.apply',
    title: '应用 diff',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'cwd');
      return {
        target,
        details: {
          strip: readNumber(record, 'strip') ?? 0,
          dryRun: readBoolean(record, 'dryRun') ?? false,
        },
      };
    },
    summarizeOutput: (output) => okOutputPathSummary(output, 'cwd'),
  },
  validate_structured_file: {
    kind: 'file.validate',
    title: '验证结构',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const target = readString(record, 'path');
      return target ? { target, details: { schema: readString(record, 'schema') } } : null;
    },
    summarizeOutput: (output) => okOutputPathSummary(output),
  },
  move_path: {
    kind: 'path.move',
    title: '移动文件',
    summarizeInput: sourceDestinationInputSummary,
    summarizeOutput: (output) => okOutputPathSummary(output, 'destination'),
  },
  copy_path: {
    kind: 'path.copy',
    title: '复制文件',
    summarizeInput: sourceDestinationInputSummary,
    summarizeOutput: (output) => okOutputPathSummary(output, 'destination'),
  },
  mkdir_path: {
    kind: 'directory.create',
    title: '建目录',
    summarizeInput: pathInputSummary,
    summarizeOutput: (output) => okOutputPathSummary(output),
  },
  glob_search: {
    kind: 'search.glob',
    title: '找文件',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'path'),
        summary: readString(record, 'pattern'),
      };
    },
  },
  grep_search: {
    kind: 'search.grep',
    title: '搜内容',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'path'),
        summary: readString(record, 'query'),
      };
    },
  },
  list_dir: {
    kind: 'directory.list',
    title: '列目录',
    summarizeInput: pathInputSummary,
  },
  run_shell: {
    kind: 'shell.run',
    title: '执行命令',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'cwd'),
        summary: readString(record, 'command'),
      };
    },
  },
  http_fetch: {
    kind: 'network.http_fetch',
    title: '请求网页',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'url'),
        details: { method: readString(record, 'method') ?? 'GET' },
      };
    },
  },
  download_file: {
    kind: 'file.download',
    title: '下载文件',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'url'),
        summary: readString(record, 'filename'),
      };
    },
    summarizeOutput: (output) => okOutputPathSummary(output),
  },
};

export const localToolOperationRegistry = createOperationRegistry(
  Object.fromEntries(
    Object.entries(localToolOperations).map(([name, metadata]) => [
      name,
      {
        ...metadata,
        source: {
          provider: 'toolkit',
          name,
        },
      },
    ]),
  ),
);
