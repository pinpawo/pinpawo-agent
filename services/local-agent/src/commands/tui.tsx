import { render } from 'ink';
import { ensureActorSelected } from '../actorSelection';
import { TuiApp } from '../tui/TuiApp';

export async function runTui(opts: { dryRun: boolean }) {
  void opts;
  const actorId = await ensureActorSelected({ interactive: true });
  const instance = render(<TuiApp actorId={actorId} />);
  await instance.waitUntilExit();
}
