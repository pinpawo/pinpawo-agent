import { connectRuntimeService, ensureRuntimeService } from '../runtimeService/launcher';
import { loadLocalEnvironment } from '../config/loadEnv';

export async function runRuntimeServiceCommand(action: string, options: { directory?: string } = {}): Promise<void> {
  if (!['start', 'status', 'stop'].includes(action)) throw new Error(`Unknown Runtime action: ${action}`);
  loadLocalEnvironment();
  const client = action === 'start'
    ? await ensureRuntimeService({ ...options, administrative: true })
    : await connectRuntimeService({ ...options, administrative: true });
  try {
    if (action === 'stop') {
      await client.stopService();
      process.stdout.write('Runtime service stopping.\n');
    } else {
      process.stdout.write(JSON.stringify(await client.status(), null, 2) + '\n');
    }
  } finally { await client.close(); }
}
