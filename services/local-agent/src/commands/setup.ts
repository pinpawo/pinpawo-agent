import {
  buildSetupGuide,
  formatSetupGuide,
  loadSetupEnvironment,
} from '../configDiagnostics';
import { loadStoredConfig } from '../storage';

export async function runSetupGuide(): Promise<void> {
  const guide = buildSetupGuide({
    stored: loadStoredConfig(),
    env: loadSetupEnvironment(),
  });
  process.stdout.write(formatSetupGuide(guide));
}
