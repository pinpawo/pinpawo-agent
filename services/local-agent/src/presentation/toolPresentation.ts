import { message, rawText, type PresentationMessage, type ToolPresentation, type ToolPresentationInput } from './types';
import { readBoolean, readNumber, readObject, readString, safeParseJson, shorten } from './utils';

type ToolStartPresenter = (parsed: Record<string, unknown> | null, rawInput: string) => ToolPresentation;
type ToolResultPresenter = (ctx: ToolPresentationInput, parsed: Record<string, unknown> | null) => PresentationMessage;

type ToolPresenter = {
  start: ToolStartPresenter;
  result?: ToolResultPresenter;
  resultWhen?: 'ok' | 'always';
};

function pathStart(toolName: string, fallbackDetailKey: string): ToolStartPresenter {
  return (parsed) => {
    const path = readString(parsed, 'path');
    return {
      label: message(`tool.${toolName}.label`),
      detail: path ? rawText(shorten(path)) : message(fallbackDetailKey),
    };
  };
}

function sourceDestinationStart(toolName: string, fallbackDetailKey: string): ToolStartPresenter {
  return (parsed) => {
    const source = readString(parsed, 'source');
    const destination = readString(parsed, 'destination');
    return {
      label: message(`tool.${toolName}.label`),
      detail: source && destination
        ? rawText(`${shorten(source, 28)} -> ${shorten(destination, 28)}`)
        : message(fallbackDetailKey),
    };
  };
}

function okPathResult(toolName: string, pathField = 'path'): ToolResultPresenter {
  return (_ctx, parsed) => {
    const path = readString(parsed, pathField);
    return path
      ? message(`tool.${toolName}.result.ok.path`, { [pathField]: shorten(path, 48) })
      : message(`tool.${toolName}.result.ok`);
  };
}

function outputOrDone(toolName: string, outputLabel = 'output'): ToolResultPresenter {
  return (ctx) => ctx.output
    ? message(`tool.${toolName}.result.ok.output`, { [outputLabel]: shorten(ctx.output, 60) })
    : message(`tool.${toolName}.result.ok`);
}

const toolPresenters: Record<string, ToolPresenter> = {
  read_file: {
    start: pathStart('read_file', 'tool.read_file.detail'),
    result: outputOrDone('read_file'),
    resultWhen: 'always',
  },
  view_file_chunk: {
    start: (parsed) => {
      const path = readString(parsed, 'path');
      const startLine = readNumber(parsed, 'startLine');
      const endLine = readNumber(parsed, 'endLine');
      return {
        label: message('tool.view_file_chunk.label'),
        detail: path
          ? rawText(`${shorten(path)}${startLine !== null ? `:${startLine}` : ''}${endLine !== null ? `-${endLine}` : ''}`)
          : message('tool.view_file_chunk.detail'),
      };
    },
    result: () => message('tool.view_file_chunk.result.ok'),
  },
  stat_path: {
    start: pathStart('stat_path', 'tool.stat_path.detail'),
    result: okPathResult('stat_path'),
  },
  write_file: {
    start: (parsed) => {
      const path = readString(parsed, 'path');
      return {
        label: message('tool.write_file.label'),
        detail: path
          ? message(readBoolean(parsed, 'append') ? 'tool.write_file.detail.append.path' : 'tool.write_file.detail.write.path', {
              path: shorten(path),
            })
          : message('tool.write_file.detail'),
      };
    },
    result: okPathResult('write_file'),
  },
  update_file: {
    start: (parsed) => {
      const path = readString(parsed, 'path');
      return {
        label: message('tool.update_file.label'),
        detail: path
          ? message(readBoolean(parsed, 'replaceAll') ? 'tool.update_file.detail.replace_all.path' : 'tool.update_file.detail.replace.path', {
              path: shorten(path),
            })
          : message('tool.update_file.detail'),
      };
    },
    result: okPathResult('update_file'),
  },
  multi_edit: {
    start: (parsed) => {
      const path = readString(parsed, 'path');
      const edits = Array.isArray(parsed?.edits) ? parsed.edits.length : '?';
      return {
        label: message('tool.multi_edit.label'),
        detail: path ? rawText(`${shorten(path)} · ${edits}`) : message('tool.multi_edit.detail'),
      };
    },
    result: okPathResult('multi_edit'),
  },
  apply_file_patch: {
    start: (parsed) => {
      const path = readString(parsed, 'path');
      const hunks = Array.isArray(parsed?.hunks) ? parsed.hunks.length : '?';
      return {
        label: message('tool.apply_file_patch.label'),
        detail: path ? rawText(`${shorten(path)} · ${hunks}`) : message('tool.apply_file_patch.detail'),
      };
    },
    result: okPathResult('apply_file_patch'),
  },
  apply_unified_patch: {
    start: (parsed) => {
      const cwd = readString(parsed, 'cwd');
      const strip = readNumber(parsed, 'strip') ?? 0;
      const dryRun = readBoolean(parsed, 'dryRun') ? ' · dry-run' : '';
      return {
        label: message('tool.apply_unified_patch.label'),
        detail: cwd
          ? rawText(`${shorten(cwd)} · -p${strip}${dryRun}`)
          : message('tool.apply_unified_patch.detail', { strip, dryRun }),
      };
    },
    result: (_ctx, parsed) => {
      const cwd = readString(parsed, 'cwd');
      const dryRun = readBoolean(parsed, 'dryRun');
      if (dryRun) {
        return cwd
          ? message('tool.apply_unified_patch.result.dry_run.path', { cwd: shorten(cwd, 48) })
          : message('tool.apply_unified_patch.result.dry_run');
      }
      return cwd
        ? message('tool.apply_unified_patch.result.applied.path', { cwd: shorten(cwd, 48) })
        : message('tool.apply_unified_patch.result.applied');
    },
  },
  validate_structured_file: {
    start: (parsed) => {
      const path = readString(parsed, 'path');
      const schema = readString(parsed, 'schema');
      return {
        label: message('tool.validate_structured_file.label'),
        detail: path
          ? rawText(`${shorten(path)}${schema && schema !== 'none' ? ` · ${schema}` : ''}`)
          : message('tool.validate_structured_file.detail'),
      };
    },
    result: okPathResult('validate_structured_file'),
  },
  move_path: {
    start: sourceDestinationStart('move_path', 'tool.move_path.detail'),
    result: okPathResult('move_path', 'destination'),
  },
  copy_path: {
    start: sourceDestinationStart('copy_path', 'tool.copy_path.detail'),
    result: okPathResult('copy_path', 'destination'),
  },
  mkdir_path: {
    start: pathStart('mkdir_path', 'tool.mkdir_path.detail'),
    result: okPathResult('mkdir_path'),
  },
  list_dir: {
    start: pathStart('list_dir', 'tool.list_dir.detail'),
    result: outputOrDone('list_dir'),
    resultWhen: 'always',
  },
  glob_search: {
    start: (parsed) => {
      const pattern = readString(parsed, 'pattern');
      const path = readString(parsed, 'path');
      return {
        label: message('tool.glob_search.label'),
        detail: pattern
          ? rawText(`${shorten(pattern)}${path ? ` @ ${shorten(path, 24)}` : ''}`)
          : message('tool.glob_search.detail'),
      };
    },
    result: outputOrDone('glob_search'),
    resultWhen: 'always',
  },
  grep_search: {
    start: (parsed) => {
      const query = readString(parsed, 'query');
      const path = readString(parsed, 'path');
      return {
        label: message('tool.grep_search.label'),
        detail: query
          ? rawText(`${shorten(query)}${path ? ` @ ${shorten(path, 24)}` : ''}`)
          : message('tool.grep_search.detail'),
      };
    },
    result: outputOrDone('grep_search'),
    resultWhen: 'always',
  },
  run_shell: {
    start: (parsed) => {
      const command = readString(parsed, 'command');
      return {
        label: message('tool.run_shell.label'),
        detail: command ? rawText(shorten(command)) : message('tool.run_shell.detail'),
      };
    },
    result: outputOrDone('run_shell'),
    resultWhen: 'always',
  },
  download_file: {
    start: (parsed) => {
      const url = readString(parsed, 'url');
      return {
        label: message('tool.download_file.label'),
        detail: url ? rawText(shorten(url)) : message('tool.download_file.detail'),
      };
    },
    result: okPathResult('download_file'),
  },
};

function presentCapabilitySearchResult(output: string): PresentationMessage {
  const parsed = output ? safeParseJson(output) : null;
  const update = readObject(parsed, 'update');
  const state = readObject(update, 'capabilitySearchState');
  if (!state) return output ? rawText(output) : message('tool.capability_search.result.done');

  const query = readString(state, 'query');
  const candidates = Array.isArray(state.candidates)
    ? state.candidates.flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object') return [];
        const record = candidate as Record<string, unknown>;
        const name = readString(record, 'name');
        if (!name) return [];
        const matchedTerms = Array.isArray(record.matchedTerms)
          ? record.matchedTerms.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          : [];
        return [matchedTerms.length > 0 ? `${name} (${matchedTerms.join('|')})` : name];
      })
    : [];
  if (candidates.length > 0) {
    return query
      ? message('tool.capability_search.result.found.query', { candidates: candidates.join('、'), query })
      : message('tool.capability_search.result.found', { candidates: candidates.join('、') });
  }
  return query
    ? message('tool.capability_search.result.empty.query', { query })
    : message('tool.capability_search.result.empty');
}

export function presentToolStart(toolName: string, input: string): ToolPresentation {
  const parsed = input ? safeParseJson(input) : null;
  const presenter = toolPresenters[toolName];
  if (presenter) return presenter.start(parsed, input);
  return {
    label: rawText(toolName),
    detail: input ? rawText(shorten(input)) : message('tool.unknown.detail'),
  };
}

export function presentToolProgress(detail: string): PresentationMessage | null {
  return detail ? rawText(shorten(detail, 80)) : null;
}

export function presentToolResult(ctx: ToolPresentationInput): PresentationMessage {
  if (ctx.error) {
    return message('tool.result.failed', { error: ctx.error.trim() });
  }
  if (ctx.toolName === 'capability_search') {
    return presentCapabilitySearchResult(ctx.output);
  }

  const parsed = ctx.output ? safeParseJson(ctx.output) : null;
  const presenter = toolPresenters[ctx.toolName];
  if (presenter?.result && (parsed?.ok || presenter.resultWhen === 'always')) {
    return presenter.result(ctx, parsed);
  }
  return ctx.output ? rawText(ctx.output) : message('tool.result.completed');
}
