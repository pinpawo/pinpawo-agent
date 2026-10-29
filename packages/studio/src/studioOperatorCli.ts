import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STUDIO_OPERATOR_HELP = `Operate an already-running Studio (no Host is started):
  pinpawo-studio channels list [--after N] [--limit N]
  pinpawo-studio channels create --title <text> [--description <text>] [--pet <petId>]...
  pinpawo-studio channels read <channelId> [--before N | --after N] [--limit N]
  pinpawo-studio channels send <channelId> --file <markdown|-> [--mention <participantId>] [--reply-to <messageId>]
  pinpawo-studio channels members <channelId>
  pinpawo-studio channels add-member <channelId> --member <participantId>
  pinpawo-studio channels remove-member <channelId> --member <participantId>
  pinpawo-studio channels sessions <channelId>
  pinpawo-studio clients list
  pinpawo-studio clients add <clientId> --label <name>
  pinpawo-studio clients add-key <clientId>
  pinpawo-studio clients revoke <clientId>
  pinpawo-studio pets list
  pinpawo-studio pets definitions
  pinpawo-studio pets create <petId> --definition <definitionId> --name <name>
  pinpawo-studio pets rename <petId> --name <name>
  pinpawo-studio pets credentials <petId>
  pinpawo-studio pets set-credential <petId> --env <NAME> --file <value|->
  pinpawo-studio pets unset-credential <petId> --env <NAME>
  pinpawo-studio queues
  pinpawo-studio snapshot <petId> [--full]
  pinpawo-studio events <petId> [--seconds N]
  pinpawo-studio dispatch <petId> --file <text|-> [--idempotency-key <key>]
  pinpawo-studio send <petId> --file <AgentClientMessage.json|->

Connection options (before or after the command):
  --studio-url <origin>  Studio HTTP (default: http://127.0.0.1:3211)
  --agent-url <origin>   Pet Agent Session HTTP (default: http://127.0.0.1:3212)
  --token-file <path>   Bearer file: the local Host token, or a client key
                        (default: ~/.pinpawo/local-server-token)

Output is JSON; events emits live SSE data as JSON lines for 1–60 seconds
(default: 30). Pagination is one page, limit 1–200 (default: 50); use nextAfter
while hasMore. channels read starts from the newest messages; --before nextBefore
reads further back while hasEarlier, --after nextAfter reads newer ones. Channel sends return a saved message and per-target deliveries,
not completion. No request is retried automatically. Read actual state before
resubmitting an uncertain mutation. --mention and --member take a participantId
(human:<id> or pet:<id>), not a display name; --mention must be a current member.
Each --pet joins the new Channel with you; no other Pet joins implicitly.
A Pet is one instance of a definition: create gives it a fixed petId that work
is addressed to and a display name that can change; several Pets may share one
definition. Archiving stops new work, lets a running turn finish and keeps the
Pet's history.
A Pet's credentials are environment variables its own shell, git and gh
commands receive; other Pets never see them. Values are write-only (credentials
lists names); set-credential reads the value from --file or stdin, so it stays
out of shell history. They need the credentials key that init creates.
A client key reaches channels commands, as the member human:<clientId>, and
pets list; everything else needs the local Host token. clients add and add-key print the
new key once; only its hash is stored. Revoking a client stops all its keys.
`;

const COMMANDS = new Set(['channels', 'clients', 'pets', 'queues', 'snapshot', 'events', 'dispatch', 'send']);
const CONNECTION_OPTIONS = new Set(['--studio-url', '--agent-url', '--token-file']);
type OperatorCommand = 'channels' | 'clients' | 'pets' | 'queues' | 'snapshot' | 'events' | 'dispatch' | 'send';
export type StudioOperatorOptions = {
  help: boolean;
  command: OperatorCommand;
  action?: string;
  id?: string;
  studioUrl: string;
  agentUrl: string;
  tokenFile: string;
  after?: number;
  before?: number;
  limit?: number;
  file?: string;
  mentions: string[];
  replyTo?: string;
  title?: string;
  description?: string;
  label?: string;
  definition?: string;
  name?: string;
  env?: string;
  pets: string[];
  member?: { kind: 'human' | 'pet'; id: string };
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
    return { help: true, command, studioUrl: '', agentUrl: '', tokenFile: '', mentions: [], pets: [], seconds: 30, full: false };
  }
  const allowed = new Set(CONNECTION_OPTIONS);
  const hasAction = command === 'channels' || command === 'clients' || command === 'pets';
  const action = hasAction ? args[start + 1] : undefined;
  if (command === 'clients') {
    if (!CLIENT_ACTIONS.includes(action ?? '')) {
      throw new Error(`Expected clients ${CLIENT_ACTIONS.slice(0, -1).join(', ')}, or ${CLIENT_ACTIONS.at(-1)}.`);
    }
    if (action === 'add') allowed.add('--label');
  }
  if (command === 'pets') {
    if (!PET_ACTIONS.includes(action ?? '')) {
      throw new Error(`Expected pets ${PET_ACTIONS.slice(0, -1).join(', ')}, or ${PET_ACTIONS.at(-1)}.`);
    }
    if (action === 'create') { allowed.add('--definition'); allowed.add('--name'); }
    if (action === 'rename') allowed.add('--name');
    if (action === 'set-credential' || action === 'unset-credential') allowed.add('--env');
    if (action === 'set-credential') allowed.add('--file');
  }
  if (command === 'channels') {
    if (!CHANNEL_ACTIONS.includes(action ?? '')) {
      throw new Error(`Expected channels ${CHANNEL_ACTIONS.slice(0, -1).join(', ')}, or ${CHANNEL_ACTIONS.at(-1)}.`);
    }
    if (['list', 'read'].includes(action!)) {
      allowed.add('--after'); allowed.add('--limit');
    }
    if (action === 'read') allowed.add('--before');
    if (action === 'send') {
      allowed.add('--file'); allowed.add('--mention'); allowed.add('--reply-to');
    }
    if (action === 'create') {
      allowed.add('--title'); allowed.add('--description'); allowed.add('--pet');
    }
    if (action === 'add-member' || action === 'remove-member') allowed.add('--member');
  }
  if (command === 'snapshot') allowed.add('--full');
  if (command === 'events') allowed.add('--seconds');
  if (command === 'dispatch' || command === 'send') allowed.add('--file');
  if (command === 'dispatch') allowed.add('--idempotency-key');
  const values = new Map<string, string>();
  const mentions: string[] = [];
  const pets: string[] = [];
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (index === start || (hasAction && index === start + 1)) continue;
    const argument = args[index];
    if (!argument.startsWith('-')) { positional.push(argument); continue; }
    if (!allowed.has(argument)) throw new Error(`Unknown option for ${command}: ${argument}`);
    if (values.has(argument) && argument !== '--mention' && argument !== '--pet') throw new Error(`Duplicate option: ${argument}`);
    if (argument === '--full') { values.set(argument, 'true'); continue; }
    const value = args[++index];
    if (!value?.trim() || (value.startsWith('-') && !(argument === '--file' && value === '-'))) {
      throw new Error(`${argument} requires a value.`);
    }
    if (argument === '--mention') mentions.push(value);
    else if (argument === '--pet') pets.push(value);
    else values.set(argument, value);
  }
  const needsId = command !== 'queues'
    && !(command === 'channels' && ['list', 'create'].includes(action!))
    && !(command === 'clients' && action === 'list')
    && !(command === 'pets' && ['list', 'definitions'].includes(action!));
  if (positional.length !== (needsId ? 1 : 0) || positional.some(value => !value.trim())) {
    const noun = command === 'channels' ? 'Channel' : command === 'clients' ? 'client' : 'Pet';
    throw new Error(needsId ? `Expected one ${noun} id.` : 'Unexpected positional argument.');
  }
  if (command === 'clients' && action === 'add' && !values.has('--label')) throw new Error('--label is required.');
  if (command === 'pets' && action === 'create' && !values.has('--definition')) throw new Error('--definition is required.');
  if (command === 'pets' && (action === 'create' || action === 'rename') && !values.has('--name')) throw new Error('--name is required.');
  if (command === 'pets' && (action === 'set-credential' || action === 'unset-credential') && !values.has('--env')) throw new Error('--env is required.');
  if ((command === 'dispatch' || command === 'send' || (command === 'channels' && action === 'send')
    || (command === 'pets' && action === 'set-credential')) && !values.has('--file')) {
    throw new Error('--file is required (use - for stdin).');
  }
  if (command === 'channels' && action === 'create' && !values.has('--title')) throw new Error('--title is required.');
  if ((action === 'add-member' || action === 'remove-member') && !values.has('--member')) throw new Error('--member is required.');
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
    after: integer('--after', 0, Number.MAX_SAFE_INTEGER), before: integer('--before', 1, Number.MAX_SAFE_INTEGER),
    limit: integer('--limit', 1, 200),
    seconds: integer('--seconds', 1, 60, 30)!, full: values.has('--full'),
    file: values.get('--file'), mentions: [...new Set(mentions)],
    replyTo: values.get('--reply-to'), idempotencyKey: values.get('--idempotency-key'),
    title: values.get('--title'), description: values.get('--description'), pets: [...new Set(pets)],
    label: values.get('--label'), definition: values.get('--definition'), name: values.get('--name'), env: values.get('--env'),
    ...(values.has('--member') ? { member: memberRef(values.get('--member')!) } : {}),
  };
}

const CHANNEL_ACTIONS = ['list', 'create', 'read', 'send', 'members', 'add-member', 'remove-member', 'sessions'];
const CLIENT_ACTIONS = ['list', 'add', 'add-key', 'revoke'];
const PET_ACTIONS = ['list', 'definitions', 'create', 'rename', 'credentials', 'set-credential', 'unset-credential'];

/** A participantId names one member: its kind and its URI-encoded id. */
function memberRef(participantId: string): { kind: 'human' | 'pet'; id: string } {
  const separator = participantId.indexOf(':');
  const kind = participantId.slice(0, separator);
  let id = '';
  try { id = decodeURIComponent(participantId.slice(separator + 1)); } catch { /* reported below */ }
  if ((kind !== 'human' && kind !== 'pet') || !id.trim()) throw new Error('--member must be a participantId such as pet:<id> or human:<id>.');
  return { kind, id };
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
    route = {
      list: '/channels', create: '/channels', read: '/channels/context', send: '/channels/messages',
      members: '/channels/members', 'add-member': '/channels/members', 'remove-member': '/channels/members/remove',
      sessions: '/channels/sessions',
    }[action!]!;
  } else if (command === 'clients') {
    route = { list: '/clients', add: '/clients', 'add-key': '/clients/keys', revoke: '/clients/revoke' }[action!]!;
    if (action === 'add') body = { clientId: id, label: options.label };
    else if (action !== 'list') body = { clientId: id };
  } else if (command === 'pets') {
    route = {
      list: '/pets', definitions: '/pet-definitions', create: '/pets', rename: '/pets/rename',
      credentials: '/pet-credentials', 'set-credential': '/pet-credentials', 'unset-credential': '/pet-credentials/remove',
    }[action!]!;
    if (action === 'create') body = { petId: id, definitionId: options.definition, name: options.name };
    else if (action === 'rename') body = { petId: id, name: options.name };
    else if (action === 'unset-credential') body = { petId: id, envName: options.env };
  } else if (['snapshot', 'events', 'send'].includes(command)) {
    base = options.agentUrl;
    route = `/agent-session/pets/${encodeURIComponent(id!)}/${command === 'send' ? 'messages' : command}`;
  } else route = command === 'queues' ? '/dispatch/queues' : `/${command}`;
  const url = new URL(route, base);
  if (options.after !== undefined) url.searchParams.set('after', String(options.after));
  if (options.before !== undefined) url.searchParams.set('before', String(options.before));
  if (options.limit !== undefined) url.searchParams.set('limit', String(options.limit));
  if (command === 'channels' && id && ['read', 'members', 'sessions'].includes(action!)) url.searchParams.set('channelId', id);
  if (command === 'pets' && action === 'credentials') url.searchParams.set('petId', id!);
  if (command === 'channels' && action === 'create') {
    body = { title: options.title, ...(options.description ? { description: options.description } : {}), pets: options.pets };
  } else if (action === 'add-member' || action === 'remove-member') {
    body = { channelId: id, ...options.member };
  }
  if (options.file) {
    const text = options.file === '-' ? await (dependencies.readStdin ?? stdinText)() : await read(options.file);
    if (command === 'channels') {
      body = { channelId: id, body: text, mentions: options.mentions.map(participantId => ({ participantId })),
        ...(options.replyTo ? { replyTo: options.replyTo } : {}) };
    } else if (command === 'pets') {
      // Exactly the value: drop one trailing newline that a file or `echo` adds.
      body = { petId: id, envName: options.env, value: text.replace(/\r?\n$/, '') };
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
