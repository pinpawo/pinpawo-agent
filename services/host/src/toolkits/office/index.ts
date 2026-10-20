import { accessSync, constants, statSync, realpathSync, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, resolve, dirname, basename } from 'node:path';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import {
  createAbortError, defineCapability, defineInstructionDocument, defineToolkit,
  readStringArray, readToolExecutionContext, ReviewPolicies, type AgentToolkit,
} from '@pinpawo/pet-agent';
import { SHELL_RS_REQUIREMENT, type ShellRS } from '../shellRS/shellRS';
import { readRecord, readString } from '../operationMetadata';
import { managedOfficeExecutable } from './dependency';
import { createCliRunner, truncateCliOutput } from '../cli/cliRunner';

const commands = ['help', 'create', 'view', 'get', 'query', 'add', 'set', 'remove', 'validate', 'close', 'batch', 'dump'] as const;

// Adapted from the Apache-2.0 iOfficeAI/OfficeCLI v1.0.156 SKILL.md for this
// Toolkit's constraints (argv form, no resident, command allowlist). Every
// claim here was checked against the 1.0.156 binary; keep it short, it is
// injected into every capability that uses the Toolkit.
export const OFFICE_TOOLKIT_INSTRUCTIONS = [
  'office_cli runs iOfficeAI/OfficeCLI 1.0.156 (guidance adapted from its Apache-2.0 SKILL.md).',
  'Call shape: command is the verb; args are the remaining argv in this order: document path, element path, then options. Never repeat the verb in args. Keep positionals before options: --prop takes several values and swallows a path placed after it. One --prop entry per key=value; text with spaces stays one entry. No shell, so no quoting.',
  'Commands: help, create, view, get, query, add, set, remove, validate, close, batch, dump. Nothing else is available (no raw, raw-set, move, swap, open, save). There is no resident: every call opens and saves the file itself and close is a no-op. Calls run one at a time; issue edits to one document in order.',
  'Paths: docx /body, /body/p[N], /body/tbl[N]/tr[R]/tc[C]; xlsx /Sheet1/A1; pptx / for slides, /slide[N]/shape[M]. add returns stable paths such as /body/p[@paraId=00100000] or /slide[1]/shape[@id=100000]; prefer them, positional indices shift after inserts.',
  'Known-good forms: create report.docx (type from extension; fails if the file exists, use a new name or --force, and if the directory is missing). add report.docx /body --type paragraph --prop text=Summary --prop style=Heading1. add report.docx /body --type table --prop data=H1,H2;a,b (rows split by ;, cells by ,). set data.xlsx /Sheet1/A1 --prop value=City; set data.xlsx /Sheet1/B3 --prop formula=B2*2. add deck.pptx / --type slide --prop title=Q3; add deck.pptx /slide[1] --type shape --prop text=Point --prop x=2cm --prop y=5cm.',
  'Use help only for what you do not know: help docx lists elements, help docx paragraph shows props with examples, help docx add table filters by verb (formats docx, xlsx, pptx). Do not guess prop names; there is no help --version.',
  'Prefer one batch for several edits to one document: one save and atomic, so if any item fails nothing is written (status failed, the result names the item). args: [file, "--commands", "<JSON array>"] or [file, "--input", "<json file>"]. Items are objects, e.g. {"command":"add","parent":"/body","type":"paragraph","props":{"text":"Hi","style":"Heading1"}}, {"command":"set","path":"/Sheet1/A1","props":{"value":"City"}}. --best-effort (any form) and @response files are not allowed.',
  'Read back in few calls: view <file> text (tables appear only as [Table: N rows]; modes are text, annotated, outline, stats, issues); get <file> <one path> --depth 2 shows a subtree including table cells; dump <file> /body (docx), /Sheet1 (xlsx) or /slide[N] (pptx) prints content as replayable batch JSON, add --json to keep CJK unescaped. get takes one path per call. Then validate <file>.',
  'Results: ok; warning may mean applied with caveats (e.g. an unsupported prop) or not applied at all (e.g. set with bare key=value and no --prop), so read back before deciding whether to retry; with --json the reported success/warnings decide the status, not the exit code; failed means a single command or batch was not applied: read stderr/stdout, which usually lists the valid props or paths; invalid_arguments means the call never ran.',
  'Prefer copies when editing existing documents. Relative paths resolve from the workdir; report actual output paths. This Toolkit does not install software, publish files, or provide a filesystem sandbox.',
].join('\n');

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

function optionMatches(arg: string, name: string) {
  return arg === name || arg.startsWith(`${name}=`) || arg.startsWith(`${name}:`);
}

// OfficeCLI's exit code does not separate "applied", "applied with warnings"
// and "applied nothing": with --json, invalid-only props give success:false
// with exit 2, and the envelope's success/warnings are the reliable signal.
// Without --json, exit 2 covers both warnings and usage errors that wrote
// nothing (e.g. set with bare key=value and no --prop): neither ok nor
// failed is safe.
function officeOutcome(code: number | null, stdout: string): { status: string; message?: string } {
  let envelope: unknown;
  try { envelope = JSON.parse(stdout.trim()); } catch { envelope = undefined; }
  const record = readRecord(envelope);
  if (record && typeof record.success === 'boolean') {
    if (!record.success) {
      return { status: 'failed', message: 'OfficeCLI reported success:false (e.g. no properties applied). Content is likely unchanged, but read back before retrying.' };
    }
    if (Array.isArray(record.warnings) && record.warnings.length > 0) {
      return { status: 'warning', message: 'Applied with warnings; some props may have been ignored. Read the document back before retrying.' };
    }
  }
  if (code === 0) return { status: 'ok' };
  if (code === 2) return { status: 'warning', message: 'Exit 2: the edit may be fully, partly or not applied. Read the document back to check before retrying.' };
  return { status: 'failed' };
}

export function officeEnabled(config: { capabilities?: Record<string, boolean> }, override?: boolean) {
  return override ?? config.capabilities?.office === true;
}

// OfficeCLI rewrites the whole package on each edit, so concurrent calls on
// one document each succeed and the last writer silently drops the others.
// The document cannot be keyed from argv: OfficeCLI accepts options before
// the path and option arity varies, so all document calls share one queue.
function createDocumentQueue() {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string | null, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> => {
    if (!key) return await run();
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    tails.set(key, tail);
    try {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(createAbortError()); return; }
        const onAbort = () => reject(createAbortError());
        signal?.addEventListener('abort', onAbort, { once: true });
        void previous.then(() => { signal?.removeEventListener('abort', onAbort); resolve(); });
      });
      return await run();
    } finally {
      release();
      // An aborted waiter finishes before its predecessor; drop the entry only
      // once the whole chain has settled so later calls still wait for it.
      void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    }
  };
}

export function createOfficeToolkit(deps: { shell: ShellRS; executable?: string }): AgentToolkit {
  const serializeDocument = createDocumentQueue();
  const binary = deps.executable ?? process.env.PINPAWO_OFFICECLI_PATH;
  const executablePath = () => {
    if (binary) return resolveOfficeExecutable(binary);
    const managed = managedOfficeExecutable();
    return (managed ? resolveOfficeExecutable(managed) : null) ?? resolveOfficeExecutable();
  };
  const officeTool = tool(async (input, runtime: ToolRuntime) => {
    const executable = executablePath();
    if (!executable) throw new Error('Office Toolkit requires iOfficeAI/OfficeCLI on PATH or an absolute PINPAWO_OFFICECLI_PATH. Run pinpawo toolkit install office explicitly; the Toolkit never installs dependencies.');
    const context = readToolExecutionContext(runtime);
    const cwd = resolve(context.workdir ?? process.cwd(), input.cwd ?? '.');
    if (input.command !== 'help' && input.args[0] === input.command) {
      return JSON.stringify({ status: 'invalid_arguments', message: `args must not repeat the command "${input.command}"; pass only the arguments after it.` });
    }
    if (input.command === 'batch') {
      // stdin is not connected, and --best-effort keeps partial writes while
      // still exiting 1, which would read as "not applied".
      if (!input.args.some((arg) => optionMatches(arg, '--commands') || optionMatches(arg, '--input'))) {
        return JSON.stringify({ status: 'invalid_arguments', message: 'batch needs --commands <JSON array> or --input <json file>; stdin is not available.' });
      }
      // System.CommandLine also accepts --opt=value / --opt:value and expands
      // @response files, either of which could smuggle in --best-effort.
      if (input.args.some((arg) => optionMatches(arg, '--best-effort') || arg.startsWith('@'))) {
        return JSON.stringify({ status: 'invalid_arguments', message: 'batch --best-effort (in any form) and @response files are not allowed; a failed batch must leave the document unchanged.' });
      }
    }
    const result = await serializeDocument(input.command === 'help' ? null : 'documents', runtime.signal, () => createCliRunner(deps.shell, runtime)([executable, input.command, ...input.args], {
      cwd, timeoutMs: input.timeoutSeconds * 1000,
      maxOutputChars: 4 * 1024 * 1024,
      // Upstream opt-outs: do not let a bounded document call bootstrap or
      // update software, or spawn a detached resident beyond ShellRS ownership.
      env: { OFFICECLI_NO_AUTO_INSTALL: '1', OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_NO_AUTO_RESIDENT: '1' },
    }));
    if (result.status === 'aborted') throw createAbortError();
    if (result.status === 'spawn_failed') throw result.error;
    if (result.status === 'yielded') return JSON.stringify({ status: 'result_unknown', processId: result.process.processId, message: 'Inspect existing effects before retrying.' });
    return JSON.stringify({
      ...(result.status === 'exited' ? officeOutcome(result.code, result.stdout) : { status: 'timeout' }),
      ...(result.status === 'exited' ? { exitCode: result.code } : { termination: result.termination ?? 'unconfirmed' }),
      stdout: truncateCliOutput(result.stdout), stderr: truncateCliOutput(result.stderr),
    });
  }, {
    name: 'office_cli',
    description: 'Use iOfficeAI/OfficeCLI to read, create and edit DOCX/XLSX/PPTX. Pass each CLI argument separately, document path first; batch applies several edits atomically. No shell interpolation or automatic installation.',
    schema: z.object({
      command: z.enum(commands),
      args: z.array(z.string().refine((value) => !value.includes('\0'), 'NUL is not allowed')).max(256).default([])
        .describe('Arguments after the command, starting with the document path; do not repeat the command.'),
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
        summarize: (input) => {
          const record = readRecord(input);
          return {
            target: readString(record, 'cwd'),
            summary: [executablePath() ?? binary ?? 'officecli', readString(record, 'command'), ...readStringArray(record, 'args')]
              .filter(Boolean).join(' '),
          };
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
    instructions: OFFICE_TOOLKIT_INSTRUCTIONS,
  });
}

export function createOfficeCapability() {
  return defineCapability({
    name: 'office', description: 'Read, create or edit Word DOCX, Excel XLSX and PowerPoint PPTX documents locally.',
    uses: ['office'], instructions: defineInstructionDocument({ content: 'Use the Office Toolkit for the requested documents. Discover the installed CLI syntax with help; decide operations from the task, inspect results and report the output paths and any verification limitations.' }),
  });
}
