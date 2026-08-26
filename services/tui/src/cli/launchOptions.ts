export type TuiLaunchOptions = {
  showVersion: boolean;
  agentSession: { port: number; petId: string } | null;
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

export function parseTuiLaunchOptions(
  argv: readonly string[],
): TuiLaunchOptions {
  const flags = new Set(argv);
  const agentSessionPort = readOption(argv, '--agent-session-port');
  const agentSessionPetId = readOption(argv, '--agent-session-pet');
  if ((agentSessionPort === undefined) !== (agentSessionPetId === undefined)) {
    throw new Error('--agent-session-port and --agent-session-pet must be provided together.');
  }
  let agentSession: TuiLaunchOptions['agentSession'] = null;
  if (agentSessionPort !== undefined && agentSessionPetId !== undefined) {
    const port = Number(agentSessionPort);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('--agent-session-port must be an integer from 1 to 65535.');
    }
    const petId = agentSessionPetId.trim();
    if (!petId) throw new Error('--agent-session-pet must not be empty.');
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

function readOption(argv: readonly string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}
