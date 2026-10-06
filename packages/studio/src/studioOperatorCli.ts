import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STUDIO_OPERATOR_HELP = `Operate an already-running Studio (no Host is started):
  pinpawo-studio channels list [--after N] [--limit N]
  pinpawo-studio channels participants
  pinpawo-studio channels read <channelId> [--after N] [--limit N]
  pinpawo-studio channels send <channelId> --file <markdown|-> [--mention <participantId>] [--reply-to <messageId>]
  pinpawo-studio channels executions <channelId> [--after N] [--limit N]
  pinpawo-studio channels interrupts <channelId> [--after N] [--limit N]
  pinpawo-studio pets
  pinpawo-studio queues
  pinpawo-studio snapshot <petId> [--full]
  pinpawo-studio events <petId> [--seconds N]
  pinpawo-studio dispatch <petId> --file <text|-> [--idempotency-key <key>]
  pinpawo-studio send <petId> --file <AgentClientMessage.json|->

Connection options (before or after the command):
  --studio-url <origin>  Studio HTTP (default: http://127.0.0.1:3211)
  --agent-url <origin>   Pet Agent Session HTTP (default: http://127.0.0.1:3212)
  --token-file <path>   Bearer file (default: ~/.pinpawo/local-server-token)

Output is JSON; events emits live SSE data as JSON lines for 1–60 seconds
(default: 30). Pagination is one page, limit 1–200 (default: 50); use nextAfter
while hasMore. Execution pages hold mutable state, not an incremental event log.
Channel sends return a saved message and per-target deliveries, not completion.
No request is retried automatically. Read actual state before resubmitting an
uncertain mutation. --mention uses a registered participantId, not a display name.
`;

const COMMANDS = new Set(['channels', 'pets', 'queues', 'snapshot', 'events', 'dispatch', 'send']);
const CONNECTION_OPTIONS = new Set(['--studio-url', '--agent-url', '--token-file']);
type OperatorCommand = 'channels' | 'pets' | 'queues' | 'snapshot' | 'events' | 'dispatch' | 'send';
export type StudioOperatorOptions = {
  help: boolean;
  command: OperatorCommand;
  action?: string;
  id?: string;
  studioUrl: string;
  agentUrl: string;
  tokenFile: string;
  after?: number;
  limit?: number;
  file?: string;
  mentions: string[];
  replyTo?: string;
  idempotencyKey?: string;
  seconds: number;
  full: boolean;
};

function origin(value: string, option: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${option} requires an HTTP(S) origin.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${option} requires an HTTP(S) origin without credentials, path, query, or fragment.`);
  }
  return url.origin;
}

/** Keep lifecycle parsing unchanged; route only recognized operator commands here. */
export function parseStudioOperatorArgs(args: readonly string[]): StudioOperatorOptions | null {
  let start = 0;
  while (CONNECTION_OPTIONS.has(args[start])) start += 2;
  if (!COMMANDS.has(args[start])) return null;
  const command = args[start] as OperatorCommand;
  if (args.includes('--help') || args.includes('-h')) {
    return { help: true, command, studioUrl: '', agentUrl: '', tokenFile: '', mentions: [], seconds: 30, full: false };
  }
  const allowed = new Set(CONNECTION_OPTIONS);
  const action = command === 'channels' ? args[start + 1] : undefined;
  if (command === 'channels') {
    if (!['list', 'participants', 'read', 'send', 'executions', 'interrupts'].includes(action ?? '')) {
      throw new Error('Expected channels list, participants, read, send, executions, or interrupts.');
    }
    if (['list', 'read', 'executions', 'interrupts'].includes(action!)) {
      allowed.add('--after'); allowed.add('--limit');
    }
    if (action === 'send') {
      allowed.add('--file'); allowed.add('--mention'); allowed.add('--reply-to');
    }
  }
  if (command === 'snapshot') allowed.add('--full');
  if (command === 'events') allowed.add('--seconds');
  if (command === 'dispatch' || command === 'send') allowed.add('--file');
  if (command === 'dispatch') allowed.add('--idempotency-key');
  const values = new Map<string, string>();
  const mentions: string[] = [];
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (index === start || (command === 'channels' && index === start + 1)) continue;
    const argument = args[index];
    if (!argument.startsWith('-')) { positional.push(argument); continue; }
    if (!allowed.has(argument)) throw new Error(`Unknown option for ${command}: ${argument}`);
    if (values.has(argument) && argument !== '--mention') throw new Error(`Duplicate option: ${argument}`);
    if (argument === '--full') { values.set(argument, 'true'); continue; }
    const value = args[++index];
    if (!value?.trim() || (value.startsWith('-') && !(argument === '--file' && value === '-'))) {
      throw new Error(`${argument} requires a value.`);
    }
    if (argument === '--mention') mentions.push(value);
    else values.set(argument, value);
  }
  const needsId = !['pets', 'queues'].includes(command)
    && !(command === 'channels' && ['list', 'participants'].includes(action!));
  if (positional.length !== (needsId ? 1 : 0) || positional.some(value => !value.trim())) {
    throw new Error(needsId ? `Expected one ${command === 'channels' ? 'Channel' : 'Pet'} id.` : 'Unexpected positional argument.');
  }
  if ((command === 'dispatch' || command === 'send' || (command === 'channels' && action === 'send')) && !values.has('--file')) {
    throw new Error('--file is required (use - for stdin).');
  }
  function integer(option: string, min: number, max: number, fallback?: number) {
    if (!values.has(option)) return fallback;
    const raw = values.get(option)!;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${option} must be an integer from ${min} to ${max}.`);
    }
    return value;
  }
  return {
    help: false, command, action, id: positional[0],
    studioUrl: origin(values.get('--studio-url') ?? 'http://127.0.0.1:3211', '--studio-url'),
    agentUrl: origin(values.get('--agent-url') ?? 'http://127.0.0.1:3212', '--agent-url'),
    tokenFile: values.get('--token-file') ?? join(homedir(), '.pinpawo/local-server-token'),
    after: integer('--after', 0, Number.MAX_SAFE_INTEGER), limit: integer('--limit', 1, 200),
    seconds: integer('--seconds', 1, 60, 30)!, full: values.has('--full'),
    file: values.get('--file'), mentions: [...new Set(mentions)],
    replyTo: values.get('--reply-to'), idempotencyKey: values.get('--idempotency-key'),
  };
}

async function stdinText() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk.toString();
  return text;
}

export type StudioOperatorDependencies = {
  fetch?: typeof fetch;
  readText?: (file: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  writeOutput?: (text: string) => void;
};

export async function runStudioOperator(options: StudioOperatorOptions, dependencies: StudioOperatorDependencies = {}) {
  const write = dependencies.writeOutput ?? process.stdout.write.bind(process.stdout);
  if (options.help) { write(STUDIO_OPERATOR_HELP); return; }
  const read = dependencies.readText ?? ((file: string) => readFile(file, 'utf8'));
  let body: unknown;
  const { command, action, id } = options;
  let route: string;
  let base = options.studioUrl;
  if (command === 'channels') {
    route = action === 'list' ? '/channels' : `/channels/${action === 'read' ? 'context' : action === 'send' ? 'messages' : action}`;
  } else if (['snapshot', 'events', 'send'].includes(command)) {
    base = options.agentUrl;
    route = `/agent-session/pets/${encodeURIComponent(id!)}/${command === 'send' ? 'messages' : command}`;
  } else route = command === 'queues' ? '/dispatch/queues' : `/${command}`;
  const url = new URL(route, base);
  if (options.after !== undefined) url.searchParams.set('after', String(options.after));
  if (options.limit !== undefined) url.searchParams.set('limit', String(options.limit));
  if (command === 'channels' && id && action !== 'send') url.searchParams.set('channelId', id);
  if (options.file) {
    const text = options.file === '-' ? await (dependencies.readStdin ?? stdinText)() : await read(options.file);
    if (command === 'channels') {
      body = { channelId: id, body: text, mentions: options.mentions.map(participantId => ({ participantId })),
        ...(options.replyTo ? { replyTo: options.replyTo } : {}) };
    } else if (command === 'dispatch') {
      body = { petId: id, request: text, idempotencyKey: options.idempotencyKey ?? randomUUID() };
    } else {
      try { body = JSON.parse(text); } catch { throw new Error('--file must contain a JSON AgentClientMessage.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('--file must contain a JSON object.');
    }
  }
  let token: string;
  try { token = (await read(options.tokenFile)).trim(); }
  catch { throw new Error('Studio bearer token is unavailable; check --token-file.'); }
  if (!token) throw new Error('Studio bearer token is empty; check --token-file.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), command === 'events' ? options.seconds * 1000 : 30_000);
  let observing = false;
  try {
    const response = await (dependencies.fetch ?? fetch)(url, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = (await response.text()).replaceAll(token, '[redacted]');
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    if (command === 'events') {
      if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
        throw new Error('Expected an Agent Session SSE response.');
      }
      observing = true;
      await readEvents(response.body, write);
      return;
    }
    let result = await response.json();
    if (command === 'snapshot' && !options.full) {
      const session = result.snapshot?.session;
      if (!session) throw new Error('Expected an Agent Session snapshot.');
      result = { queue: result.queue, sessionId: session.sessionId, activeRun: session.activeRun,
        pendingInterrupt: session.pendingInterrupt, currentPlan: session.currentPlan,
        recentTimeline: session.timeline?.slice(-4) ?? [] };
    }
    write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    // A normal bounded event observation ends without cancelling the Pet run.
    if (command === 'events' && controller.signal.aborted && observing) return;
    const detail = (error instanceof Error ? error.message : String(error)).replaceAll(token, '[redacted]');
    throw new Error(`${detail}${body === undefined ? '' : ' Request was not retried; inspect state before resubmitting.'}`);
  } finally { clearTimeout(timeout); }
}

async function readEvents(stream: ReadableStream<Uint8Array>, write: (text: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        else if (!line && data.length) {
          const payload = JSON.parse(data.join('\n'));
          write(`${JSON.stringify(payload)}\n`);
          data = [];
        }
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
