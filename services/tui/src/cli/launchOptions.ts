export type TuiLaunchOptions = {
  showVersion: boolean;
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
    studio: boolean;
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
    studio: flags.has('--smoke-studio'),
    transcript: flags.has('--smoke-transcript'),
  };
  const hostSmoke = smoke.hostReady || smoke.hostChat;
  const smokeEnabled = smoke.base
    || smoke.command
    || smoke.edit
    || smoke.policy
    || smoke.review
    || smoke.studio
    || smoke.transcript
    || hostSmoke;

  return {
    showVersion: flags.has('--version'),
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
