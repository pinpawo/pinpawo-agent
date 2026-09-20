export type TuiEmbeddedHostTarget = {
  command: string;
  args: string[];
};

export type TuiLaunchOptions = {
  showVersion: boolean;
  agentSession: { port: number; petId: string } | null;
  /**
   * Host command for embedded stdio mode, where the terminal UI starts and owns
   * the Host child process. `pinpawo tui --embed-host` already rejects the
   * combinations that cannot carry an embedded Host (Pet mode, check, QA).
   */
  embeddedHost: TuiEmbeddedHostTarget | null;
  demo: {
    command: boolean;
    qa: boolean;
    review: boolean;
  };
  smoke: {
    base: boolean;
    command: boolean;
    edit: boolean;
    hostChat: boolean;
    hostReady: boolean;
    policy: boolean;
    review: boolean;
    transcript: boolean;
  };
  smokeEnabled: boolean;
  hostSmoke: boolean;
  useDemoConnection: boolean;
};

const DEFAULT_EMBEDDED_HOST_COMMAND = 'pinpawo';
const DEFAULT_EMBEDDED_HOST_ARGS = ['run', '--stdio'];

export function parseTuiLaunchOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): TuiLaunchOptions {
  const flags = new Set(argv);
  const agentSessionPort = readOption(argv, '--pet-port');
  const agentSessionPetId = readOption(argv, '--pet-id');
  if ((agentSessionPort === undefined) !== (agentSessionPetId === undefined)) {
    throw new Error('--pet-port and --pet-id must be provided together.');
  }
  let agentSession: TuiLaunchOptions['agentSession'] = null;
  if (agentSessionPort !== undefined && agentSessionPetId !== undefined) {
    const port = Number(agentSessionPort);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('--pet-port must be an integer from 1 to 65535.');
    }
    const petId = agentSessionPetId.trim();
    if (!petId) throw new Error('--pet-id must not be empty.');
    agentSession = { port, petId };
  }
  const demo = {
    command: flags.has('--demo-command'),
    qa: flags.has('--demo-qa'),
    review: flags.has('--demo-review'),
  };
  const smoke = {
    base: flags.has('--smoke'),
    command: flags.has('--smoke-command'),
    edit: flags.has('--smoke-edit'),
    hostChat: flags.has('--smoke-host-chat'),
    hostReady: flags.has('--smoke-host'),
    policy: flags.has('--smoke-policy'),
    review: flags.has('--smoke-review'),
    transcript: flags.has('--smoke-transcript'),
  };
  const hostSmoke = smoke.hostReady || smoke.hostChat;
  const smokeEnabled = smoke.base
    || smoke.command
    || smoke.edit
    || smoke.policy
    || smoke.review
    || smoke.transcript
    || hostSmoke;

  return {
    showVersion: flags.has('--version'),
    agentSession,
    embeddedHost: flags.has('--embed-host')
      ? readEmbeddedHostTarget(env)
      : null,
    demo,
    smoke,
    smokeEnabled,
    hostSmoke,
    useDemoConnection: (smokeEnabled && !hostSmoke)
      || demo.command
      || demo.qa
      || demo.review,
  };
}

/**
 * The launcher resolves the Host runtime and forwards it as an environment
 * contract, so the terminal UI never has to guess where the local agent lives.
 * Without it the flag falls back to the `pinpawo` executable on `PATH`.
 */
export function readEmbeddedHostTarget(
  env: NodeJS.ProcessEnv = process.env,
): TuiEmbeddedHostTarget {
  const command = env.PINPAWO_EMBED_HOST_COMMAND?.trim();
  return {
    command: command || DEFAULT_EMBEDDED_HOST_COMMAND,
    args: readEmbeddedHostArgs(env.PINPAWO_EMBED_HOST_ARGS),
  };
}

function readEmbeddedHostArgs(value: string | undefined): string[] {
  const raw = value?.trim();
  if (!raw) return [...DEFAULT_EMBEDDED_HOST_ARGS];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PINPAWO_EMBED_HOST_ARGS must be a JSON array of arguments.');
  }
  if (
    !Array.isArray(parsed)
    || parsed.some((item) => typeof item !== 'string' || item === '')
  ) {
    throw new Error('PINPAWO_EMBED_HOST_ARGS must be a JSON array of arguments.');
  }
  return parsed as string[];
}

function readOption(argv: readonly string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}
