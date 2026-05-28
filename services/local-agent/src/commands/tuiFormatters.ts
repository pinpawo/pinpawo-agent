function safeParseJson(text: string) {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function shorten(value: string, max = 60) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export function formatStudioTurnEvent(event: Record<string, unknown>): string | null {
  const type = typeof event.type === 'string' ? event.type : null;
  if (!type) return null;
  switch (type) {
    case 'turn_started':
      return null;
    case 'plan_set': {
      const plan = event.plan && typeof event.plan === 'object'
        ? event.plan as Record<string, unknown>
        : null;
      const tasks = plan && Array.isArray(plan.tasks) ? plan.tasks : [];
      return `[studio] plan 设定:${tasks.length} 棒`;
    }
    case 'dispatch_started': {
      const petId = typeof event.petId === 'string' ? event.petId : '?';
      const taskIndex = typeof event.taskIndex === 'number' ? event.taskIndex : '?';
      return `[studio] dispatch[#${taskIndex}] → pet:${petId}`;
    }
    case 'task_status_changed': {
      const taskIndex = typeof event.taskIndex === 'number' ? event.taskIndex : '?';
      const status = typeof event.status === 'string' ? event.status : '?';
      return `[studio] task[#${taskIndex}] → ${status}`;
    }
    case 'wiki_updated': {
      const changed = Array.isArray(event.changedPaths) ? event.changedPaths : [];
      return `[studio] wiki 更新 ${changed.length} 项`;
    }
    case 'dispatch_finished': {
      const dispatchId = typeof event.dispatchId === 'string' ? event.dispatchId : '?';
      const status = typeof event.status === 'string' ? event.status : '?';
      return `[studio] dispatch ${dispatchId} → ${status}`;
    }
    case 'turn_finished':
      return null;
    default:
      return `[studio] event: ${type}`;
  }
}

export function formatToolStart(toolName: string, input: string) {
  const parsed = input ? safeParseJson(input) : null;

  switch (toolName) {
    case 'read_file':
      return {
        label: '读文件',
        detail: typeof parsed?.path === 'string' ? shorten(parsed.path) : '读取文件内容',
      };
    case 'view_file_chunk':
      return {
        label: '看片段',
        detail: typeof parsed?.path === 'string'
          ? `${shorten(parsed.path)}${typeof parsed.startLine === 'number' ? `:${parsed.startLine}` : ''}${typeof parsed.endLine === 'number' ? `-${parsed.endLine}` : ''}`
          : '查看文件片段',
      };
    case 'stat_path':
      return {
        label: '看属性',
        detail: typeof parsed?.path === 'string' ? shorten(parsed.path) : '查看路径信息',
      };
    case 'write_file':
      return {
        label: '写文件',
        detail: typeof parsed?.path === 'string'
          ? `${parsed.append ? '追加' : '写入'} ${shorten(parsed.path)}`
          : '写入文件内容',
      };
    case 'update_file':
      return {
        label: '改文件',
        detail: typeof parsed?.path === 'string'
          ? `${parsed.replaceAll ? '批量替换' : '替换'} ${shorten(parsed.path)}`
          : '更新文件内容',
      };
    case 'multi_edit':
      return {
        label: '批量修改',
        detail: typeof parsed?.path === 'string'
          ? `${shorten(parsed.path)} · ${Array.isArray(parsed.edits) ? parsed.edits.length : '?'} 处`
          : '执行多组替换',
      };
    case 'apply_file_patch':
      return {
        label: '应用补丁',
        detail: typeof parsed?.path === 'string'
          ? `${shorten(parsed.path)} · ${Array.isArray(parsed.hunks) ? parsed.hunks.length : '?'} 段`
          : '按补丁更新文件',
      };
    case 'apply_unified_patch':
      return {
        label: '应用 diff',
        detail: typeof parsed?.cwd === 'string'
          ? `${shorten(parsed.cwd)} · -p${typeof parsed?.strip === 'number' ? parsed.strip : 0}${parsed?.dryRun ? ' · 预检' : ''}`
          : `当前目录 · -p${typeof parsed?.strip === 'number' ? parsed.strip : 0}${parsed?.dryRun ? ' · 预检' : ''}`,
      };
    case 'validate_structured_file':
      return {
        label: '验证结构',
        detail: typeof parsed?.path === 'string'
          ? `${shorten(parsed.path)}${typeof parsed?.schema === 'string' && parsed.schema !== 'none' ? ` · ${parsed.schema}` : ''}`
          : '验证结构化文件',
      };
    case 'move_path':
      return {
        label: '移动文件',
        detail: typeof parsed?.source === 'string' && typeof parsed?.destination === 'string'
          ? `${shorten(parsed.source, 28)} -> ${shorten(parsed.destination, 28)}`
          : '移动文件或目录',
      };
    case 'copy_path':
      return {
        label: '复制文件',
        detail: typeof parsed?.source === 'string' && typeof parsed?.destination === 'string'
          ? `${shorten(parsed.source, 28)} -> ${shorten(parsed.destination, 28)}`
          : '复制文件或目录',
      };
    case 'mkdir_path':
      return {
        label: '建目录',
        detail: typeof parsed?.path === 'string' ? shorten(parsed.path) : '创建目录',
      };
    case 'list_dir':
      return {
        label: '列目录',
        detail: typeof parsed?.path === 'string' ? shorten(parsed.path) : '查看目录内容',
      };
    case 'glob_search':
      return {
        label: '找文件',
        detail: typeof parsed?.pattern === 'string'
          ? `${shorten(parsed.pattern)}${typeof parsed.path === 'string' ? ` @ ${shorten(parsed.path, 24)}` : ''}`
          : '按模式搜索文件',
      };
    case 'grep_search':
      return {
        label: '搜内容',
        detail: typeof parsed?.query === 'string'
          ? `${shorten(parsed.query)}${typeof parsed.path === 'string' ? ` @ ${shorten(parsed.path, 24)}` : ''}`
          : '递归搜索文件内容',
      };
    case 'run_shell':
      return {
        label: '执行命令',
        detail: typeof parsed?.command === 'string' ? shorten(parsed.command) : '执行 shell 命令',
      };
    case 'download_file':
      return {
        label: '下载文件',
        detail: typeof parsed?.url === 'string' ? shorten(parsed.url) : '下载远程文件',
      };
    default:
      return {
        label: toolName,
        detail: input ? shorten(input) : '',
      };
  }
}

export function formatToolProgress(_toolName: string, detail: string) {
  return detail ? shorten(detail, 80) : '';
}

export function formatToolResult(toolName: string, output: string, error: string) {
  if (error) {
    return `失败 · ${error.trim()}`;
  }

  const parsed = output ? safeParseJson(output) : null;
  if (toolName === 'capability_search') {
    const state = parsed?.update && typeof parsed.update === 'object'
      ? (parsed.update as Record<string, unknown>).capabilitySearchState
      : null;
    if (state && typeof state === 'object') {
      const stateRecord = state as Record<string, unknown>;
      const query = typeof stateRecord.query === 'string' && stateRecord.query.trim()
        ? stateRecord.query.trim()
        : null;
      const candidates = Array.isArray(stateRecord.candidates)
        ? stateRecord.candidates.flatMap((candidate) => {
            if (!candidate || typeof candidate !== 'object') return [];
            const record = candidate as Record<string, unknown>;
            const name = typeof record.name === 'string' ? record.name : null;
            if (!name) return [];
            const matchedTerms = Array.isArray(record.matchedTerms)
              ? record.matchedTerms.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
              : [];
            return [matchedTerms.length > 0 ? `${name} (${matchedTerms.join('|')})` : name];
          })
        : [];
      if (candidates.length > 0) {
        return `找到 capability：${candidates.join('、')}${query ? ` · query: ${query}` : ''}`;
      }
      return `未找到 capability 候选${query ? ` · query: ${query}` : ''}`;
    }
    return output || '已搜索 capability';
  }

  if (parsed?.ok) {
    switch (toolName) {
      case 'write_file':
        return typeof parsed.path === 'string'
          ? `已写入 ${shorten(parsed.path, 48)}`
          : '已写入';
      case 'view_file_chunk':
        return '已读取片段';
      case 'stat_path':
        return typeof parsed.path === 'string'
          ? `已查看 ${shorten(parsed.path, 48)}`
          : '已查看';
      case 'update_file':
        return typeof parsed.path === 'string'
          ? `已更新 ${shorten(parsed.path, 48)}`
          : '已更新';
      case 'multi_edit':
        return typeof parsed.path === 'string'
          ? `已批量修改 ${shorten(parsed.path, 48)}`
          : '已批量修改';
      case 'apply_file_patch':
        return typeof parsed.path === 'string'
          ? `已应用补丁 ${shorten(parsed.path, 48)}`
          : '已应用补丁';
      case 'apply_unified_patch':
        return typeof parsed.cwd === 'string'
          ? `${parsed.dryRun ? '预检通过' : '已应用'} ${shorten(parsed.cwd, 48)}`
          : (parsed.dryRun ? '预检通过' : '已应用 diff');
      case 'validate_structured_file':
        return typeof parsed.path === 'string'
          ? `已验证 ${shorten(parsed.path, 48)}`
          : '已验证结构';
      case 'move_path':
        return typeof parsed.destination === 'string'
          ? `已移动到 ${shorten(parsed.destination, 48)}`
          : '已移动';
      case 'copy_path':
        return typeof parsed.destination === 'string'
          ? `已复制到 ${shorten(parsed.destination, 48)}`
          : '已复制';
      case 'mkdir_path':
        return typeof parsed.path === 'string'
          ? `已创建 ${shorten(parsed.path, 48)}`
          : '已创建';
      case 'glob_search':
        return output ? `找到 ${shorten(output, 60)}` : '已完成搜索';
      case 'grep_search':
        return output ? `命中 ${shorten(output, 60)}` : '已完成搜索';
      case 'download_file':
        return typeof parsed.path === 'string'
          ? `已下载到 ${shorten(parsed.path, 48)}`
          : '已下载';
      default:
        return '已完成';
    }
  }

  if (toolName === 'list_dir') {
    return output ? `已列出 ${output}` : '已列目录';
  }
  if (toolName === 'read_file') {
    return output ? `已读取 ${output}` : '已读取';
  }
  if (toolName === 'run_shell') {
    return output ? `结果 ${output}` : '已执行';
  }
  return output || '已完成';
}
