import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { parse } from 'shell-quote';

const LIMIT = 24_000;
const MAX_FILES = 12;

/** Static snapshots only. No package manager, interpreter or make is invoked. */
export async function collectShellEvidence(input: unknown, workdir: string | null): Promise<string> {
  const args = input as { command?: unknown; cwd?: unknown } | null;
  if (typeof args?.command !== 'string') return 'Unavailable: missing command.';
  let cwd = resolve(workdir ?? process.cwd(), typeof args.cwd === 'string' ? args.cwd : '.');
  const facts: string[] = ['Static source snapshots; includes do not prove complete execution semantics. Files can change after review.'];
  const seen = new Set<string>();
  let remaining = LIMIT;
  const note = (text: string) => { facts.push(text); };
  async function read(path: string): Promise<string | null> {
    path = resolve(path);
    if (seen.has(path)) return null;
    if (seen.size >= MAX_FILES || remaining <= 0) { note(`Unavailable: source budget exceeded at ${path}`); return null; }
    seen.add(path);
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      if (!(await file.stat()).isFile()) { note(`Unavailable: ${path} is not a regular file`); return null; }
      const buffer = Buffer.alloc(Math.min(remaining, LIMIT) + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, Math.min(bytesRead, remaining)).toString('utf8');
      const truncated = bytesRead > remaining;
      remaining -= text.length;
      note(JSON.stringify({ path, source: text, truncated }));
      return text;
    } catch { note(`Unavailable: cannot read ${path}`); return null; }
    finally { await file?.close(); }
  }
  async function entry(script: string, directory: string) {
    // Only direct literal file operands. Other programs and transitive imports remain unverified.
    const match = /^(?:node|python3?|bash|sh)\s+(?!-)([^\s;&|]+)|^(\.\/?[^\s;&|]+\.(?:sh|js|mjs|cjs|py))\b/.exec(script);
    if (match) await read(resolve(directory, match[1] ?? match[2]));
  }
  async function packageEvidence(directory: string, script: string | undefined, workspace?: string, searchUp = true) {
    let path = resolve(directory, 'package.json');
    // npm searches upward from cwd unless an explicit prefix selects its root.
    while (searchUp) {
      try { const f = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); await f.close(); break; }
      catch { const parent = dirname(dirname(path)); if (parent === dirname(path)) break; path = resolve(parent, 'package.json'); }
    }
    const raw = await read(path);
    if (!raw) return;
    let pkg;
    try { pkg = JSON.parse(raw); } catch { note('Unavailable: invalid or truncated package.json'); return; }
    if (workspace) {
      // Resolve literal workspace paths and package names against declared, shallow workspace patterns.
      const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      const candidates: string[] = [];
      for (const pattern of Array.isArray(patterns) ? patterns : []) {
        if (typeof pattern !== 'string') continue;
        if (pattern.endsWith('/*')) {
          try { for (const name of (await readdir(resolve(dirname(path), pattern.slice(0, -2)))).slice(0, 80)) candidates.push(resolve(dirname(path), pattern.slice(0, -1), name)); } catch { /* missing workspace */ }
        } else if (!pattern.includes('*')) candidates.push(resolve(dirname(path), pattern));
      }
      for (const candidate of candidates) {
        if (candidate === resolve(dirname(path), workspace)) { await packageEvidence(candidate, script); return; }
        try {
          const f = await open(resolve(candidate, 'package.json'), constants.O_RDONLY | constants.O_NONBLOCK);
          try {
            const b = Buffer.alloc(8192); const result = await f.read(b, 0, b.length, 0);
            if (JSON.parse(b.subarray(0, result.bytesRead).toString()).name === workspace) { await packageEvidence(candidate, script); return; }
          } finally { await f.close(); }
        } catch { /* not a matching package */ }
      }
      note(`Unavailable: workspace ${workspace} could not be resolved`); return;
    }
    note(`npm target: ${script ?? '(list scripts)'}; lifecycle pre/post scripts are in the package snapshot; npm configuration/environment and transitive programs are not resolved.`);
    if (script) {
      for (const name of [`pre${script}`, script, `post${script}`]) {
        const value = pkg.scripts?.[name];
        if (typeof value === 'string') await entry(value, dirname(path));
        else if (name === script) note(`Unavailable: script ${script} absent (npm implicit defaults may apply)`);
      }
    }
  }
  async function makeEvidence(path: string, directory: string) {
    const source = await read(path);
    if (source === null) return;
    for (const line of source.split('\n')) {
      const include = /^\s*-?include\s+(.+)$/.exec(line);
      if (!include) continue;
      for (const file of include[1].split(/\s+/)) {
        if (/[$*?%]/.test(file)) note(`Unresolved make include: ${file}`);
        else await makeEvidence(resolve(directory, file), directory);
      }
    }
    note('Make snapshot includes recipes, targets and prerequisites; variable expansion, generated includes, recursive make and referenced programs are not fully resolved. $(shell ...) may run while parsing, even with -n/-q/-p.');
  }
  let tokens;
  try { tokens = args.command.split(/\r?\n/).flatMap(line => [...parse(line, name => '${' + name + '}'), { op: ';' as const }]); }
  catch { return 'Unavailable: shell syntax could not be parsed; indirect effects unverified.'; }
  let words: string[] = [];
  async function inspect() {
    if (!words.length) return;
    const [program, ...rest] = words;
    if (program === 'cd' && rest.length === 1 && !/[$`]/.test(rest[0])) { cwd = resolve(cwd, rest[0]); return; }
    const name = basename(program);
    if (name === 'npm') {
      let explicitPrefix = false;
      let workspaceCount = 0;
      let directory = cwd; let workspace: string | undefined; const positional: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === '--') break;
        if (['--prefix', '-C'].includes(arg)) { directory = resolve(cwd, rest[++i] ?? '.'); explicitPrefix = true; }
        else if (['--workspace', '-w'].includes(arg)) { workspace = rest[++i]; workspaceCount++; }
        else if (arg.startsWith('--prefix=')) { directory = resolve(cwd, arg.slice(9)); explicitPrefix = true; }
        else if (arg.startsWith('--workspace=')) { workspace = arg.slice(12); workspaceCount++; }
        else if (/^-w.+/.test(arg)) { workspace = arg.slice(2); workspaceCount++; }
        else if (arg.startsWith('-')) note(`Unresolved npm option: ${arg}`);
        else positional.push(arg);
      }
      if (workspaceCount > 1) note('Unresolved: multiple workspaces requested; snapshot covers only the final selector');
      const sub = positional[0];
      if (['run', 'run-script', 'test', 'start', 'stop', 'restart'].includes(sub)) await packageEvidence(directory, ['run', 'run-script'].includes(sub) ? positional[1] : sub, workspace, !explicitPrefix);
    } else if (name === 'make' || name === 'gmake') {
      let directory = cwd; const files: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (['-C', '--directory'].includes(rest[i])) directory = resolve(directory, rest[++i] ?? '.');
        else if (/^-C.+/.test(rest[i])) directory = resolve(directory, rest[i].slice(2));
        else if (rest[i].startsWith('--directory=')) directory = resolve(directory, rest[i].slice(12));
        else if (['-f', '--file', '--makefile'].includes(rest[i])) files.push(rest[++i]);
        else if (/^(?:--file|--makefile)=/.test(rest[i])) files.push(rest[i].split('=').slice(1).join('='));
        else if (/^-f.+/.test(rest[i])) files.push(rest[i].slice(2));
        else if (rest[i].startsWith('-') && !['-n', '-q', '-p', '--dry-run', '--question', '--just-print'].includes(rest[i])) note(`Unresolved make option: ${rest[i]}`);
      }
      if (!files.length) {
        for (const file of ['GNUmakefile', 'makefile', 'Makefile']) {
          try { const f = await open(resolve(directory, file), constants.O_RDONLY | constants.O_NONBLOCK); await f.close(); files.push(file); break; } catch { /* next standard filename */ }
        }
      }
      if (!files.length) note('Unavailable: no standard Makefile found');
      for (const file of files) await makeEvidence(resolve(directory, file), directory);
    } else if (/^(?:node|python3?|sh|bash)$/.test(name) || /\.(?:sh|js|mjs|cjs|py)$/.test(program)) await entry(words.join(' '), cwd);
    else if (['env', 'command', 'exec', 'pnpm', 'yarn', 'bun'].includes(name)) note(`Unresolved indirect execution: ${words.join(' ')}`);
  }
  for (const token of [...tokens, { op: ';' }]) {
    if (typeof token === 'string') words.push(token);
    else if ('op' in token) {
      await inspect(); words = [];
      if (![';', '&&'].includes(token.op)) note(`Unresolved shell control/redirection: ${token.op}; cwd/effects may differ`);
    }
  }
  return facts.join('\n');
}
