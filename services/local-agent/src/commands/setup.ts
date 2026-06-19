import {
  buildSetupGuide,
  formatSetupGuide,
  loadSetupEnvironment,
} from '../configDiagnostics';
import { loadStoredConfig } from '../storage';

export async function runSetupGuide(options: { workdir?: string } = {}): Promise<void> {
  const guide = buildSetupGuide({
    stored: loadStoredConfig(),
    env: loadSetupEnvironment(),
    workdir: options.workdir,
  });
  process.stdout.write(formatSetupGuide(guide));
}
