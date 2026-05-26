import { execFileSync, execSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, resolve, isAbsolute } from 'node:path';
import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  buildHumanReviewRequest,
  type HumanReviewActionRequest,
  type AgentToolkit,
  type ToolkitToolReviewPolicy,
} from '@pinpawo/pet-agent';
import type { LocalAgentPlugin } from '../pluginLoader';
import { config } from '../config';
import { isShellCommandAuthorized } from '../sessionAuthorizations';
import { getCurrentLocalAgentInterface } from '../chatInterface';

const DEFAULT_DOWNLOADS_DIR = resolve(homedir(), 'Downloads');

const capabilityManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().min(1),
  color: z.string().min(1),
  defaultEnabled: z.boolean(),
  builtIn: z.boolean(),
  comingSoon: z.boolean().optional(),
});

function resolveUserPath(path: string) {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2));
  }
  if (isAbsolute(path)) {
    return path;
  }
  // Relative paths anchor to agent workdir, not process.cwd()
  return resolve(config.workdir, path);
}

function tryStat(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function formatStat(path: string) {
  const stat = statSync(path);
  return JSON.stringify({
    path,
    type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    ctime: stat.ctime.toISOString(),
  });
}

function resolveMoveTarget(sourcePath: string, destinationPath: string) {
  const source = resolveUserPath(sourcePath);
  const destination = resolveUserPath(destinationPath);
  const destinationStat = tryStat(destination);
  return destinationStat?.isDirectory()
    ? resolve(destination, basename(source))
    : destination;
}

function resolveCopyTarget(sourcePath: string, destinationPath: string) {
  return resolveMoveTarget(sourcePath, destinationPath);
}

function wildcardToRegExp(pattern: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function walkFiles(rootPath: string, visit: (filePath: string) => boolean | void) {
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const stat = tryStat(current);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const entries = readdirSync(current);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        stack.push(resolve(current, entries[i] ?? ''));
      }
      continue;
    }
    if (visit(current) === false) {
      return;
    }
  }
}

function getBlockedShellReason(command: string) {
  const normalized = command.trim();

  const blockedPatterns: Array<[RegExp, string]> = [
    [/(^|[\s;&|])mv(\s|$)/, '禁止直接使用 mv；请改用 move_path。'],
    [/\bgit\s+reset\s+--hard\b/, '禁止使用 git reset --hard 这类破坏性命令。'],
    [/(^|[\s;&|])sudo(\s|$)/, '禁止通过 sudo 提权执行命令。'],
    [/(^|[\s;&|])(mkfs|fdisk|shutdown|reboot|dd)(\s|$)/, '禁止执行高风险系统命令。'],
    [/\bcat\s*>\s*/, 'run_shell 不支持依赖 stdin 的 cat > 写文件；请改用 write_file。'],
    [/<<[-\w'"]*/, 'run_shell 不支持 heredoc；请改用 write_file。'],
  ];

  for (const [pattern, reason] of blockedPatterns) {
    if (pattern.test(normalized)) {
      return reason;
    }
  }

  if (hasBlockedOutputRedirection(normalized)) {
    return 'run_shell 不支持输出重定向写文件；请改用 write_file。';
  }

  return null;
}

function hasBlockedOutputRedirection(command: string) {
  const withoutFdDuplication = command.replace(/(^|[\s;&|])\d*>\s*&\d+\b/g, '$1');
  return /(^|[^=>])\d*>>?/.test(withoutFdDuplication);
}

function processOutputToString(output: unknown) {
  if (typeof output === 'string') {
    return output.trimEnd();
  }
  if (Buffer.isBuffer(output)) {
    return output.toString('utf-8').trimEnd();
  }
  return '';
}

function getShellConfirmationRisk(command: string) {
  const normalized = command.trim();

  const confirmPatterns: Array<[RegExp, string]> = [
    [/(^|[\s;&|])rm(\s|$)/, '删除文件或目录'],
    [/\bgit\s+(push|tag|rebase|merge|cherry-pick|commit)\b/, 'git 写操作或远端变更'],
    [/\b(npm|pnpm|yarn)\s+publish\b/, '包发布'],
    [/\b(kubectl|helm)\s+(apply|delete|rollout|upgrade|uninstall)\b/, '集群部署变更'],
    [/\bdocker\s+(push|buildx\s+build|compose\s+(up|down)|run)\b/, '容器构建或运行变更'],
    [/\b(chmod|chown)\b/, '权限或属主变更'],
    [/\bfind\b[\s\S]*\s-delete\b/, '批量删除'],
    [/\bcurl\b[\s\S]*\|\s*(sh|bash|zsh)\b/, '远程脚本直接执行'],
  ];

  for (const [pattern, risk] of confirmPatterns) {
    if (pattern.test(normalized)) {
      return risk;
    }
  }

  return null;
}

function buildShellHumanReviewRequest(command: string, cwd: string, risk: string) {
  return buildHumanReviewRequest({
    actionRequests: [{
      name: 'run_shell',
      args: { command, cwd },
      description: `即将执行高风险 shell 命令（${risk}）。`,
    }],
    reviewConfigs: [{
      actionName: 'run_shell',
      allowedDecisions: ['approve', 'edit', 'reject', 'respond'],
      description: risk,
    }],
    prompt: `即将执行高风险 shell 命令（${risk}）。\n目录：${cwd}\n命令：${command}\n请确认是否执行，或修改命令/说明新的处理方向。`,
  });
}

function normalizeShellActionInput(input: unknown) {
  if (!input || typeof input !== 'object') {
    throw new Error('run_shell requires a command');
  }
  const record = input as Record<string, unknown>;
  const command = typeof record.command === 'string' && record.command.trim()
    ? record.command.trim()
    : null;
  if (!command) {
    throw new Error('run_shell requires a command');
  }
  const cwd = typeof record.cwd === 'string' && record.cwd.trim()
    ? resolveUserPath(record.cwd.trim())
    : config.workdir;
  return { command, cwd };
}

function readEditedShellAction(
  editedAction: HumanReviewActionRequest,
  fallback: { command: string; cwd: string },
) {
  if (
    editedAction.name !== 'run_shell'
    && editedAction.name !== 'shell'
  ) {
    return fallback;
  }
  const command = typeof editedAction.args.command === 'string' && editedAction.args.command.trim()
    ? editedAction.args.command.trim()
    : fallback.command;
  const cwd = typeof editedAction.args.cwd === 'string' && editedAction.args.cwd.trim()
    ? resolveUserPath(editedAction.args.cwd.trim())
    : fallback.cwd;
  return { command, cwd };
}

const readFileTool = tool(
  async ({ path }: { path: string }) => {
    try {
      const content = readFileSync(resolveUserPath(path), 'utf-8');
      return content.slice(0, 8000);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'read_file',
    description: '读取本地文件内容。path 支持绝对路径或相对路径（相对于当前工作目录）。',
    schema: z.object({ path: z.string().describe('文件路径') }),
  },
);

const viewFileChunkTool = tool(
  async ({ path, startLine, endLine }: {
    path: string;
    startLine?: number;
    endLine?: number;
  }) => {
    try {
      const filePath = resolveUserPath(path);
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(1, startLine ?? 1);
      const end = Math.min(lines.length, endLine ?? Math.min(start + 199, lines.length));
      if (end < start) {
        return `Error: invalid line range ${start}-${end}`;
      }
      return lines
        .slice(start - 1, end)
        .map((line, index) => `${start + index}: ${line}`)
        .join('\n');
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'view_file_chunk',
    description: '按行读取文件片段。适合查看大文件的局部内容，返回带行号的文本。',
    schema: z.object({
      path: z.string().describe('文件路径'),
      startLine: z.number().int().positive().optional().describe('起始行号，默认 1'),
      endLine: z.number().int().positive().optional().describe('结束行号，默认最多返回 200 行'),
    }),
  },
);

const statPathTool = tool(
  async ({ path }: { path: string }) => {
    try {
      const resolvedPath = resolveUserPath(path);
      return formatStat(resolvedPath);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'stat_path',
    description: '查看文件或目录元信息。返回类型、大小、修改时间等。',
    schema: z.object({
      path: z.string().describe('文件或目录路径'),
    }),
  },
);

const writeFileTool = tool(
  async ({ path, content, append, createDirs }: {
    path: string;
    content: string;
    append?: boolean;
    createDirs?: boolean;
  }) => {
    try {
      const filePath = resolveUserPath(path);
      if (createDirs ?? true) {
        mkdirSync(dirname(filePath), { recursive: true });
      }
      writeFileSync(filePath, content, {
        encoding: 'utf-8',
        flag: append ? 'a' : 'w',
      });
      return JSON.stringify({
        ok: true,
        path: filePath,
        mode: append ? 'append' : 'write',
        bytes: Buffer.byteLength(content, 'utf-8'),
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'write_file',
    description: '写入本地文本文件。适合直接创建或覆盖文件内容；如需追加，传 append=true。默认会自动创建父目录。如果写入的是 JSON、manifest.json、package.json、tsconfig.json 等结构化文件，写完后应继续调用 validate_structured_file 做结构校验。',
    schema: z.object({
      path: z.string().describe('目标文件路径；支持绝对路径或相对路径'),
      content: z.string().describe('要写入的文本内容'),
      append: z.boolean().optional().describe('是否以追加模式写入；默认 false 表示覆盖'),
      createDirs: z.boolean().optional().describe('是否自动创建父目录；默认 true'),
    }),
  },
);

const updateFileTool = tool(
  async ({ path, find, replace, replaceAll }: {
    path: string;
    find: string;
    replace: string;
    replaceAll?: boolean;
  }) => {
    try {
      const filePath = resolveUserPath(path);
      const original = readFileSync(filePath, 'utf-8');

      if (!find) {
        return 'Error: find must not be empty';
      }

      const matches = original.split(find).length - 1;
      if (matches === 0) {
        return `Error: target text not found in ${filePath}`;
      }

      const next = replaceAll
        ? original.split(find).join(replace)
        : original.replace(find, replace);

      writeFileSync(filePath, next, 'utf-8');

      return JSON.stringify({
        ok: true,
        path: filePath,
        replaced: replaceAll ? matches : 1,
        replaceAll: Boolean(replaceAll),
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'update_file',
    description: '更新本地文件中的已有内容。适合把文件里某一段文本替换成新文本；默认只替换首个匹配，传 replaceAll=true 可替换全部匹配。如果修改的是 JSON、manifest.json、package.json、tsconfig.json 等结构化文件，修改后应继续调用 validate_structured_file。',
    schema: z.object({
      path: z.string().describe('目标文件路径'),
      find: z.string().describe('要查找的原始文本，不能为空'),
      replace: z.string().describe('替换后的新文本'),
      replaceAll: z.boolean().optional().describe('是否替换全部匹配；默认 false'),
    }),
  },
);

const multiEditTool = tool(
  async ({ path, edits }: {
    path: string;
    edits: Array<{ find: string; replace: string; replaceAll?: boolean }>;
  }) => {
    try {
      const filePath = resolveUserPath(path);
      let content = readFileSync(filePath, 'utf-8');
      let totalReplaced = 0;

      for (const edit of edits) {
        if (!edit.find) {
          return 'Error: edit.find must not be empty';
        }
        const matches = content.split(edit.find).length - 1;
        if (matches === 0) {
          return `Error: target text not found in ${filePath}: ${edit.find.slice(0, 80)}`;
        }
        content = edit.replaceAll
          ? content.split(edit.find).join(edit.replace)
          : content.replace(edit.find, edit.replace);
        totalReplaced += edit.replaceAll ? matches : 1;
      }

      writeFileSync(filePath, content, 'utf-8');
      return JSON.stringify({
        ok: true,
        path: filePath,
        edits: edits.length,
        replaced: totalReplaced,
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'multi_edit',
    description: '对同一个文件执行多组文本替换。适合一次完成多个局部更新，减少反复读写。如果目标是结构化文件，完成后应继续调用 validate_structured_file。',
    schema: z.object({
      path: z.string().describe('目标文件路径'),
      edits: z.array(z.object({
        find: z.string().describe('要查找的原始文本'),
        replace: z.string().describe('替换后的新文本'),
        replaceAll: z.boolean().optional().describe('是否替换全部匹配；默认 false'),
      })).min(1).describe('要依次执行的编辑列表'),
    }),
  },
);

const applyFilePatchTool = tool(
  async ({ path, hunks }: {
    path: string;
    hunks: Array<{
      oldText: string;
      newText: string;
      replaceAll?: boolean;
      expectedOccurrences?: number;
    }>;
  }) => {
    try {
      const filePath = resolveUserPath(path);
      let content = readFileSync(filePath, 'utf-8');
      const applied: Array<{
        index: number;
        replaced: number;
        replaceAll: boolean;
      }> = [];

      for (let index = 0; index < hunks.length; index += 1) {
        const hunk = hunks[index];
        if (!hunk || !hunk.oldText) {
          return `Error: hunks[${index}] oldText must not be empty`;
        }

        const matches = content.split(hunk.oldText).length - 1;
        if (matches === 0) {
          return `Error: patch hunk ${index} not found in ${filePath}`;
        }
        if (typeof hunk.expectedOccurrences === 'number' && matches !== hunk.expectedOccurrences) {
          return `Error: patch hunk ${index} expected ${hunk.expectedOccurrences} matches but found ${matches} in ${filePath}`;
        }

        const replaceAll = Boolean(hunk.replaceAll);
        content = replaceAll
          ? content.split(hunk.oldText).join(hunk.newText)
          : content.replace(hunk.oldText, hunk.newText);

        applied.push({
          index,
          replaced: replaceAll ? matches : 1,
          replaceAll,
        });
      }

      writeFileSync(filePath, content, 'utf-8');
      return JSON.stringify({
        ok: true,
        path: filePath,
        hunks: applied,
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'apply_file_patch',
    description: '用一组严格的文本 patch 更新文件。每个 hunk 都要求 oldText 精确命中；可设置 expectedOccurrences 防止文件漂移时误改。适合像 Claude Code/Codex 一样做最小补丁式更新。如果补丁修改的是结构化文件，完成后应继续调用 validate_structured_file。',
    schema: z.object({
      path: z.string().describe('目标文件路径'),
      hunks: z.array(z.object({
        oldText: z.string().describe('要精确匹配的原始文本块'),
        newText: z.string().describe('替换后的新文本块'),
        replaceAll: z.boolean().optional().describe('是否替换全部匹配；默认 false'),
        expectedOccurrences: z.number().int().positive().optional().describe('期望匹配次数；若实际不符则直接报错'),
      })).min(1).describe('按顺序应用的一组文本 patch'),
    }),
  },
);

const applyUnifiedPatchTool = tool(
  async ({ patch, cwd, strip, dryRun }: {
    patch: string;
    cwd?: string;
    strip?: number;
    dryRun?: boolean;
  }) => {
    let tempDir: string | null = null;
    try {
      const patchText = patch.trim();
      if (!patchText) {
        return 'Error: patch must not be empty';
      }

      const targetDir = cwd ? resolveUserPath(cwd) : config.workdir;
      const targetStat = tryStat(targetDir);
      if (!targetStat?.isDirectory()) {
        return `Error: patch cwd must be an existing directory: ${targetDir}`;
      }

      tempDir = mkdtempSync(resolve(tmpdir(), 'pinpawo-patch-'));
      const patchFile = resolve(tempDir, 'change.patch');
      writeFileSync(patchFile, patchText.endsWith('\n') ? patchText : `${patchText}\n`, 'utf-8');

      const patchArgs = [
        '--batch',
        '--forward',
        `-p${Math.max(0, strip ?? 0)}`,
        '-i',
        patchFile,
        '-d',
        targetDir,
      ];
      if (dryRun) {
        patchArgs.unshift('--dry-run');
      }

      const output = execFileSync('patch', patchArgs, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      return JSON.stringify({
        ok: true,
        cwd: targetDir,
        strip: Math.max(0, strip ?? 0),
        dryRun: Boolean(dryRun),
        output: output.trim() || null,
      });
    } catch (err) {
      const message = err instanceof Error
        ? ('stderr' in err && typeof (err as { stderr?: unknown }).stderr === 'string'
          ? (err as { stderr: string }).stderr.trim() || err.message
          : err.message)
        : String(err);
      return `Error: ${message}`;
    } finally {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  },
  {
    name: 'apply_unified_patch',
    description: '应用 unified diff / patch 到一个目录。适合多文件或更复杂的块级修改。默认在当前 workdir 执行 patch，可传 cwd 指定目标目录；可传 strip 控制 -p 层级，传 dryRun=true 先验证不落盘。若 patch 涉及 JSON、manifest.json、package.json、tsconfig.json 等结构化文件，应用后应继续调用 validate_structured_file 检查结果。',
    schema: z.object({
      patch: z.string().describe('unified diff / patch 文本'),
      cwd: z.string().optional().describe('应用 patch 的目标目录；默认当前 workdir'),
      strip: z.number().int().min(0).optional().describe('传给 patch 的 -p 层级；默认 0'),
      dryRun: z.boolean().optional().describe('是否只做 dry-run 校验，不实际写入'),
    }),
  },
);

const validateStructuredFileTool = tool(
  async ({ path, format, schema }: {
    path: string;
    format?: 'auto' | 'json';
    schema?: 'none' | 'capability_manifest';
  }) => {
    try {
      const filePath = resolveUserPath(path);
      const content = readFileSync(filePath, 'utf-8');
      const detectedFormat = format && format !== 'auto'
        ? format
        : extname(filePath).toLowerCase() === '.json'
          ? 'json'
          : 'json';

      if (detectedFormat !== 'json') {
        return `Error: unsupported structured format: ${detectedFormat}`;
      }

      const parsed = JSON.parse(content) as unknown;
      let schemaWarnings: string[] = [];
      if (schema === 'capability_manifest') {
        const result = capabilityManifestSchema.safeParse(parsed);
        if (!result.success) {
          return JSON.stringify({
            ok: false,
            path: filePath,
            format: detectedFormat,
            schema: schema ?? 'none',
            error: result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; '),
          });
        }
        if (result.data.builtIn !== false) {
          schemaWarnings = ['用户 capability manifest 建议写 builtIn: false'];
        }
      }

      return JSON.stringify({
        ok: true,
        path: filePath,
        format: detectedFormat,
        schema: schema ?? 'none',
        warnings: schemaWarnings,
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'validate_structured_file',
    description: '验证结构化文件内容。当前支持 JSON 语法检查，以及 capability_manifest 这类 schema 校验。适合在 write_file / update_file / apply_file_patch 之后单独执行验证。',
    schema: z.object({
      path: z.string().describe('要验证的文件路径'),
      format: z.enum(['auto', 'json']).optional().describe('结构格式；默认 auto，目前实际支持 json'),
      schema: z.enum(['none', 'capability_manifest']).optional().describe('可选 schema 校验类型'),
    }),
  },
);

const movePathTool = tool(
  async ({ source, destination, overwrite, createDirs }: {
    source: string;
    destination: string;
    overwrite?: boolean;
    createDirs?: boolean;
  }) => {
    try {
      const sourcePath = resolveUserPath(source);
      const sourceStat = statSync(sourcePath);
      const targetPath = resolveMoveTarget(source, destination);

      if (createDirs ?? true) {
        mkdirSync(dirname(targetPath), { recursive: true });
      }

      const targetStat = tryStat(targetPath);
      if (targetStat) {
        if (!overwrite) {
          return `Error: destination already exists: ${targetPath}`;
        }
        rmSync(targetPath, { recursive: true, force: true });
      }

      try {
        renameSync(sourcePath, targetPath);
      } catch (err) {
        const isCrossDevice = err instanceof Error
          && 'code' in err
          && (err as NodeJS.ErrnoException).code === 'EXDEV';

        if (!isCrossDevice) {
          throw err;
        }

        cpSync(sourcePath, targetPath, {
          recursive: sourceStat.isDirectory(),
          force: overwrite ?? false,
          errorOnExist: !(overwrite ?? false),
        });
        rmSync(sourcePath, { recursive: sourceStat.isDirectory(), force: true });
      }

      return JSON.stringify({
        ok: true,
        source: sourcePath,
        destination: targetPath,
        type: sourceStat.isDirectory() ? 'directory' : 'file',
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'move_path',
    description: '移动本地文件或目录。优先用于文件/目录搬迁，包括普通目录、外接磁盘和已挂载的 SMB/网络共享卷；跨卷移动会自动复制后删除源路径。若 destination 是已存在目录，则会移动到该目录下并保留原名称。默认不覆盖目标；如需覆盖，传 overwrite=true。',
    schema: z.object({
      source: z.string().describe('源文件或目录路径'),
      destination: z.string().describe('目标路径；可以是目标文件路径，也可以是已存在目录'),
      overwrite: z.boolean().optional().describe('目标已存在时是否覆盖；默认 false'),
      createDirs: z.boolean().optional().describe('是否自动创建目标父目录；默认 true'),
    }),
  },
);

const copyPathTool = tool(
  async ({ source, destination, overwrite, createDirs }: {
    source: string;
    destination: string;
    overwrite?: boolean;
    createDirs?: boolean;
  }) => {
    try {
      const sourcePath = resolveUserPath(source);
      const sourceStat = statSync(sourcePath);
      const targetPath = resolveCopyTarget(source, destination);

      if (createDirs ?? true) {
        mkdirSync(dirname(targetPath), { recursive: true });
      }

      const targetStat = tryStat(targetPath);
      if (targetStat && !overwrite) {
        return `Error: destination already exists: ${targetPath}`;
      }

      cpSync(sourcePath, targetPath, {
        recursive: sourceStat.isDirectory(),
        force: overwrite ?? false,
        errorOnExist: !(overwrite ?? false),
      });

      return JSON.stringify({
        ok: true,
        source: sourcePath,
        destination: targetPath,
        type: sourceStat.isDirectory() ? 'directory' : 'file',
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'copy_path',
    description: '复制本地文件或目录。优先用于文件/目录复制，包括普通目录、外接磁盘和已挂载的 SMB/网络共享卷。若 destination 是已存在目录，则复制到该目录下并保留原名称。默认不覆盖目标；如需覆盖，传 overwrite=true。',
    schema: z.object({
      source: z.string().describe('源文件或目录路径'),
      destination: z.string().describe('目标路径；可以是目标文件路径，也可以是已存在目录'),
      overwrite: z.boolean().optional().describe('目标已存在时是否覆盖；默认 false'),
      createDirs: z.boolean().optional().describe('是否自动创建目标父目录；默认 true'),
    }),
  },
);

const mkdirPathTool = tool(
  async ({ path, recursive }: { path: string; recursive?: boolean }) => {
    try {
      const targetPath = resolveUserPath(path);
      mkdirSync(targetPath, { recursive: recursive ?? true });
      return JSON.stringify({
        ok: true,
        path: targetPath,
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'mkdir_path',
    description: '创建本地目录。默认递归创建父目录。',
    schema: z.object({
      path: z.string().describe('要创建的目录路径'),
      recursive: z.boolean().optional().describe('是否递归创建；默认 true'),
    }),
  },
);

const globSearchTool = tool(
  async ({ path, pattern, limit }: { path?: string; pattern: string; limit?: number }) => {
    try {
      const rootPath = resolveUserPath(path ?? '.');
      const regex = wildcardToRegExp(pattern);
      const maxResults = Math.max(1, Math.min(limit ?? 50, 200));
      const matches: string[] = [];

      walkFiles(rootPath, (filePath) => {
        const relative = filePath.startsWith(`${rootPath}/`)
          ? filePath.slice(rootPath.length + 1)
          : basename(filePath);
        if (regex.test(relative) || regex.test(basename(filePath))) {
          matches.push(filePath);
        }
        return matches.length < maxResults;
      });

      return matches.length > 0 ? matches.join('\n') : '(no matches)';
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'glob_search',
    description: '按通配符模式递归搜索文件。适合查找某类文件，如 *.md、src/**/*.ts 的简化匹配。返回匹配到的文件路径列表。',
    schema: z.object({
      path: z.string().optional().describe('搜索起点目录，默认 "."'),
      pattern: z.string().describe('通配符模式，支持 * 和 ?'),
      limit: z.number().int().positive().max(200).optional().describe('最多返回多少条，默认 50'),
    }),
  },
);

const grepSearchTool = tool(
  async ({ path, query, limit, caseSensitive }: {
    path?: string;
    query: string;
    limit?: number;
    caseSensitive?: boolean;
  }) => {
    try {
      const rootPath = resolveUserPath(path ?? '.');
      const maxResults = Math.max(1, Math.min(limit ?? 50, 200));
      const needle = caseSensitive ? query : query.toLowerCase();
      const results: string[] = [];

      walkFiles(rootPath, (filePath) => {
        let content: string;
        try {
          content = readFileSync(filePath, 'utf-8');
        } catch {
          return results.length < maxResults;
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? '';
          const haystack = caseSensitive ? line : line.toLowerCase();
          if (!haystack.includes(needle)) {
            continue;
          }
          results.push(`${filePath}:${i + 1}: ${line}`);
          if (results.length >= maxResults) {
            return false;
          }
        }

        return results.length < maxResults;
      });

      return results.length > 0 ? results.join('\n') : '(no matches)';
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'grep_search',
    description: '递归搜索文件内容，返回匹配行及其文件路径和行号。适合定位某个词、函数名或报错文本。',
    schema: z.object({
      path: z.string().optional().describe('搜索起点目录，默认 "."'),
      query: z.string().describe('要搜索的文本'),
      limit: z.number().int().positive().max(200).optional().describe('最多返回多少条，默认 50'),
      caseSensitive: z.boolean().optional().describe('是否区分大小写，默认 false'),
    }),
  },
);

const listDirTool = tool(
  async ({ path }: { path: string }) => {
    try {
      const dirPath = resolveUserPath(path);
      const entries = readdirSync(dirPath);
      const lines = entries.map((name) => {
        try {
          const stat = statSync(resolve(dirPath, name));
          return `${stat.isDirectory() ? 'd' : 'f'} ${name}`;
        } catch {
          return `? ${name}`;
        }
      });
      return lines.join('\n') || '(empty)';
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'list_dir',
    description: '列出目录内容。返回每个条目的类型（d=目录, f=文件）和名称。',
    schema: z.object({ path: z.string().describe('目录路径，默认 "." 表示当前目录') }),
  },
);

const runShellTool = tool(
  async (input: { command: string; cwd?: string }) => {
    let shellAction: { command: string; cwd: string };

    try {
      shellAction = normalizeShellActionInput(input);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }

    const blockedReason = getBlockedShellReason(shellAction.command);
    if (blockedReason) {
      return `Error: ${blockedReason}`;
    }

    const confirmationRisk = getShellConfirmationRisk(shellAction.command);
    const { threadId, capabilities } = getCurrentLocalAgentInterface();
    const isAuthorized = threadId && capabilities.sessionAuthorization
      ? isShellCommandAuthorized(threadId, shellAction.command)
      : false;
    if (confirmationRisk && !isAuthorized && !capabilities.humanReview) {
      return `Error: shell command requires human review before execution: ${confirmationRisk}`;
    }

    try {
      const output = execSync(shellAction.command, {
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 64,
        cwd: shellAction.cwd,
      });
      return output.slice(0, 4000) || '(no output)';
    } catch (err) {
      if (err instanceof Error && ('stdout' in err || 'stderr' in err)) {
        const stdout = processOutputToString((err as { stdout?: unknown }).stdout);
        const stderr = processOutputToString((err as { stderr?: unknown }).stderr);
        const output = [stderr, stdout].filter(Boolean).join('\n');
        const status = (err as NodeJS.ErrnoException & { status?: number }).status ?? '?';
        return `Error (exit ${status}):\n${output || err.message}`;
      }
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'run_shell',
    description: '兜底工具：执行非交互 shell 命令并返回输出。只有没有更具体的专用工具覆盖时才使用；不要用它替代 read_file/write_file/update_file/move_path/copy_path/mkdir_path/list_dir/glob_search/grep_search/http_fetch/download_file。默认在当前 workdir 执行，相对路径也默认相对于该目录；如有需要可显式传 cwd 覆盖。超时 10s，输出截断至 4000 字符；不要用于需要输入、全屏 TTY、持续运行，或依赖 stdin 的命令（例如 cat > file）。高风险命令会先进入 toolkit 审批，可批准、编辑、拒绝或给出新的处理方向。',
    schema: z.object({
      command: z.string().describe('要执行的 shell 命令'),
      cwd: z.string().optional().describe('命令执行目录；默认当前 workdir'),
    }),
  },
);

function sanitizeFilename(filename: string) {
  return filename.replace(/[\\/:*?"<>|]/g, '_').trim() || `download-${Date.now()}`;
}

function inferFilename(url: string, explicitFilename?: string | null, contentType?: string | null) {
  if (explicitFilename?.trim()) {
    return sanitizeFilename(explicitFilename.trim());
  }

  try {
    const pathname = new URL(url).pathname;
    const base = basename(pathname);
    if (base && extname(base)) {
      return sanitizeFilename(base);
    }
    if (base) {
      const ext = contentType?.includes('image/jpeg')
        ? '.jpg'
        : contentType?.includes('image/png')
          ? '.png'
          : contentType?.includes('image/webp')
            ? '.webp'
            : contentType?.includes('image/gif')
              ? '.gif'
              : '';
      return sanitizeFilename(`${base}${ext}`);
    }
  } catch {
    // ignore URL parse failure
  }

  const ext = contentType?.includes('image/jpeg')
    ? '.jpg'
    : contentType?.includes('image/png')
      ? '.png'
      : contentType?.includes('image/webp')
        ? '.webp'
        : contentType?.includes('image/gif')
          ? '.gif'
          : '';
  return `download-${Date.now()}${ext}`;
}

/** Strip HTML to readable plain text — removes scripts/styles, collapses tags to whitespace. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|h[1-6]|blockquote|section|article|header|footer|nav|main)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MAX_FETCH_BYTES = 100_000;
const FETCH_TIMEOUT_MS = 15_000;

const httpFetchTool = tool(
  async ({ url, method, headers, body, format }: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    format?: 'text' | 'json' | 'raw';
  }) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(url, {
          method: method ?? 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/json,*/*',
            ...headers,
          },
          body: body ?? undefined,
          redirect: 'follow',
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const contentType = response.headers.get('content-type') ?? '';
      const rawText = await response.text();
      const truncated = rawText.slice(0, MAX_FETCH_BYTES);

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}\n${truncated.slice(0, 500)}`;
      }

      const resolvedFormat = format
        ?? (contentType.includes('json') ? 'json' : 'text');

      if (resolvedFormat === 'json') {
        try {
          return JSON.stringify(JSON.parse(truncated), null, 2).slice(0, 8000);
        } catch {
          return truncated.slice(0, 8000);
        }
      }

      if (resolvedFormat === 'raw') {
        return truncated.slice(0, 8000);
      }

      // 'text': strip HTML tags for readability
      const text = contentType.includes('html') ? htmlToText(truncated) : truncated;
      return text.slice(0, 8000) || '(empty response)';
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'http_fetch',
    description: '通过 HTTP 请求获取网页或 API 内容，不会打开浏览器窗口，也不会复用浏览器登录态。适合不依赖 JS 渲染的页面、REST API、RSS 等。HTML 响应默认自动去除标签返回纯文本；JSON 响应格式化返回；传 format="raw" 返回原始内容。不支持需要登录态、页面交互或 JS 动态加载的页面；这类任务应交给浏览器 capability。',
    schema: z.object({
      url: z.string().url().describe('目标 URL'),
      method: z.string().optional().describe('HTTP 方法，默认 GET'),
      headers: z.record(z.string()).optional().describe('自定义请求头，如 Cookie、Authorization 等'),
      body: z.string().optional().describe('请求体，POST 时使用'),
      format: z.enum(['text', 'json', 'raw']).optional().describe('返回格式：text=去除 HTML 标签的纯文本（默认），json=格式化 JSON，raw=原始内容'),
    }),
  },
);

const downloadFileTool = tool(
  async ({ url, filename }: { url: string; filename?: string }) => {
    try {
      mkdirSync(DEFAULT_DOWNLOADS_DIR, { recursive: true });
      const response = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'PinPawo Local Agent/1.0',
        },
      });
      if (!response.ok) {
        return `Error: download failed with status ${response.status}`;
      }
      const contentType = response.headers.get('content-type');
      const targetFilename = inferFilename(url, filename, contentType);
      const filePath = resolve(DEFAULT_DOWNLOADS_DIR, targetFilename);
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(filePath, buffer);
      return JSON.stringify({
        ok: true,
        path: filePath,
        bytes: buffer.byteLength,
        contentType,
      });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'download_file',
    description: '从 URL 下载文件到本机 Downloads 目录。适合下载图片或页面里提取到的资源链接，不要再用 shell/curl 做下载。',
    schema: z.object({
      url: z.string().url().describe('要下载的文件 URL'),
      filename: z.string().optional().describe('可选的保存文件名；不传则自动推断'),
    }),
  },
);

const coreLocalPluginTools: StructuredTool[] = [
  readFileTool,
  viewFileChunkTool,
  statPathTool,
  writeFileTool,
  updateFileTool,
  multiEditTool,
  applyFilePatchTool,
  applyUnifiedPatchTool,
  validateStructuredFileTool,
  movePathTool,
  copyPathTool,
  mkdirPathTool,
  listDirTool,
  globSearchTool,
  grepSearchTool,
  httpFetchTool,
  downloadFileTool,
  runShellTool,
];

const bashToolkitInstructions = [
  '你可以使用本地文件、搜索、下载和 shell 工具完成任务。',
  '优先使用语义具体的文件工具：read_file、view_file_chunk、list_dir、glob_search、grep_search、update_file、apply_file_patch。',
  'run_shell 只作为兜底工具；不要用它替代已有的读写、移动、复制、下载或 HTTP 工具。',
  '执行高风险 shell 命令时必须遵守 toolkit 的人类审批流程，不要绕过审批。',
  '修改文件前先读取现状；修改后优先用 validate_structured_file、grep_search 或 run_shell 做必要验证。',
];

const shellReviewPolicy: ToolkitToolReviewPolicy = {
  request: ({ input }) => {
    let shellAction: { command: string; cwd: string };
    try {
      shellAction = normalizeShellActionInput(input);
    } catch {
      return null;
    }

    if (getBlockedShellReason(shellAction.command)) {
      return null;
    }

    const confirmationRisk = getShellConfirmationRisk(shellAction.command);
    if (!confirmationRisk) {
      return null;
    }

    const { threadId, capabilities } = getCurrentLocalAgentInterface();
    const isAuthorized = threadId && capabilities.sessionAuthorization
      ? isShellCommandAuthorized(threadId, shellAction.command)
      : false;
    if (isAuthorized) {
      return null;
    }

    if (!capabilities.humanReview) {
      return null;
    }

    return buildShellHumanReviewRequest(
      shellAction.command,
      shellAction.cwd,
      confirmationRisk,
    );
  },
  applyEdit: ({ input, editedAction }) => readEditedShellAction(
    editedAction,
    normalizeShellActionInput(input),
  ),
};

export function createBashToolkit(tools: StructuredTool[] = coreLocalPluginTools): AgentToolkit {
  return {
    name: 'bash',
    description: '本地文件读写、目录操作、代码搜索、补丁应用、HTTP 下载，以及受控 shell 命令执行。',
    tools,
    instructions: bashToolkitInstructions,
    policy: {
      toolReview: {
        run_shell: shellReviewPolicy,
      },
    },
  };
}

let cachedLocalPluginTools: StructuredTool[] | null = null;

export async function loadLocalPluginTools(): Promise<StructuredTool[]> {
  if (cachedLocalPluginTools) {
    return cachedLocalPluginTools;
  }

  cachedLocalPluginTools = coreLocalPluginTools;

  return cachedLocalPluginTools;
}

export const localPlugin: LocalAgentPlugin = {
  name: 'local-cli',
};
