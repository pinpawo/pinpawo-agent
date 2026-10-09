import { accessSync, constants, statSync, realpathSync, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, resolve, dirname, basename } from 'node:path';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import {
  createAbortError, defineCapability, defineInstructionDocument, defineToolkit,
  readToolExecutionContext, ReviewPolicies, type AgentToolkit,
} from '@pinpawo/pet-agent';
import { SHELL_RS_REQUIREMENT, type ShellRS } from '../shellRS/shellRS';
import { readRecord, readString } from '../operationMetadata';
import { managedOfficeExecutable } from './dependency';
import { createCliRunner, truncateCliOutput } from '../cli/cliRunner';

const commands = ['help', 'create', 'view', 'get', 'query', 'add', 'set', 'remove', 'validate', 'close'] as const;

export function resolveOfficeExecutable(binary: string = 'officecli', path = process.env.PATH ?? ''): string | null {
  const candidates = isAbsolute(binary) ? [binary] : binary.includes('/')
    ? [] : path.split(delimiter).filter(Boolean).map((dir) => resolve(dir, binary));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isFile()) continue;
      const actual = realpathSync(candidate);
      // The official npm launcher downloads lazily if vendor/officecli is
      // absent. Resolve its already-installed native binary without running it.
      if (basename(actual) === 'officecli.js') {
        const pkg = JSON.parse(readFileSync(resolve(dirname(actual), 'package.json'), 'utf8'));
        if (pkg.name !== '@officecli/officecli') continue;
        const native = resolve(dirname(actual), 'vendor', process.platform === 'win32' ? 'officecli.exe' : 'officecli');
        accessSync(native, constants.X_OK);
        if (statSync(native).isFile()) return native;
        continue;
      }
      return actual;
    } catch { /* Try the next PATH entry without executing any installer. */ }
  }
  return null;
}

export function officeEnabled(config: { capabilities?: Record<string, boolean> }, override?: boolean) {
  return override ?? config.capabilities?.office === true;
}

export function createOfficeToolkit(deps: { shell: ShellRS; executable?: string }): AgentToolkit {
  const binary = deps.executable ?? process.env.PINPAWO_OFFICECLI_PATH;
  const executablePath = () => binary ? resolveOfficeExecutable(binary)
    : resolveOfficeExecutable(managedOfficeExecutable() ?? '/missing/officecli') ?? resolveOfficeExecutable();
  const officeTool = tool(async (input, runtime: ToolRuntime) => {
    const executable = executablePath();
    if (!executable) throw new Error('Office Toolkit requires iOfficeAI/OfficeCLI on PATH or an absolute PINPAWO_OFFICECLI_PATH. Run pinpawo toolkit install office explicitly; the Toolkit never installs dependencies.');
    const context = readToolExecutionContext(runtime);
    const cwd = resolve(context.workdir ?? process.cwd(), input.cwd ?? '.');
    const result = await createCliRunner(deps.shell, runtime)([executable, input.command, ...input.args], {
      cwd, timeoutMs: input.timeoutSeconds * 1000,
      maxOutputChars: 4 * 1024 * 1024,
      // Upstream opt-outs: do not let a bounded document call bootstrap or
      // update software, or spawn a detached resident beyond ShellRS ownership.
      env: { OFFICECLI_NO_AUTO_INSTALL: '1', OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_NO_AUTO_RESIDENT: '1' },
    });
    if (result.status === 'aborted') throw createAbortError();
    if (result.status === 'spawn_failed') throw result.error;
    if (result.status === 'yielded') return JSON.stringify({ status: 'result_unknown', processId: result.process.processId, message: 'Inspect existing effects before retrying.' });
    return JSON.stringify({
      status: result.status === 'exited' ? (result.code === 0 ? 'ok' : 'failed') : 'timeout',
      ...(result.status === 'exited' ? { exitCode: result.code } : { termination: result.termination ?? 'unconfirmed' }),
      stdout: truncateCliOutput(result.stdout), stderr: truncateCliOutput(result.stderr),
    });
  }, {
    name: 'office_cli',
    description: 'Use iOfficeAI/OfficeCLI to read, create and edit DOCX/XLSX/PPTX. Pass each CLI argument separately; help discovers syntax. No shell interpolation or automatic installation.',
    schema: z.object({
      command: z.enum(commands),
      args: z.array(z.string().refine((value) => !value.includes('\0'), 'NUL is not allowed')).max(256).default([]),
      cwd: z.string().optional(),
      timeoutSeconds: z.number().int().min(1).max(600).default(60),
    }),
  });
  return defineToolkit({
    name: 'office', description: 'Optional local Office document editing through iOfficeAI/OfficeCLI.',
    tools: [{
      tool: officeTool,
      operation: {
        title: 'OfficeCLI',
        summarizeInput: (input) => {
          const record = readRecord(input);
          return { target: readString(record, 'cwd'), details: {
            executable: executablePath() ?? binary ?? 'officecli', command: readString(record, 'command'), args: record?.args,
          } };
        },
      },
      review: ReviewPolicies.required({ authorization: 'exact' }),
    }],
    requires: { shell: SHELL_RS_REQUIREMENT },
    availability: async () => {
      const shell = await deps.shell.status();
      if (!shell.available) return shell;
      return executablePath() ? { available: true } : {
        available: false,
        reason: 'Office is enabled but iOfficeAI/OfficeCLI is missing. Run pinpawo toolkit install office explicitly, or set absolute PINPAWO_OFFICECLI_PATH; then restart the Host.',
      };
    },
    instructions: 'Use office_cli help to discover installed command syntax. Read document structure before editing; choose your own operations. Use separate argv entries (including paths or text with spaces). Prefer copies for edits; validate and read back results, close any opened OfficeCLI document session before delivery. Relative output paths resolve from the workdir; report their actual paths. This Toolkit does not install software, publish files, or provide a filesystem sandbox.',
  });
}

export function createOfficeCapability() {
  return defineCapability({
    name: 'office', description: 'Read, create or edit Word DOCX, Excel XLSX and PowerPoint PPTX documents locally.',
    uses: ['office'], instructions: defineInstructionDocument({ content: 'Use the Office Toolkit for the requested documents. Discover the installed CLI syntax with help; decide operations from the task, inspect results and report the output paths and any verification limitations.' }),
  });
}
