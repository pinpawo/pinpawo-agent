import React from 'react';
import { render } from 'ink';
import { ensureActorSelected } from '../actorSelection';
import { applyRuntimeWorkdir } from '../runtimeWorkdir';
import { TuiApp } from '../tui/TuiApp';

export async function runTui(opts: { dryRun: boolean; workdir?: string }) {
  const runtimeConfig = applyRuntimeWorkdir(opts.workdir);
  const actorId = await ensureActorSelected({ interactive: true });
  const instance = render(<TuiApp actorId={actorId} workdir={runtimeConfig.workdir} />);
  await instance.waitUntilExit();
}
