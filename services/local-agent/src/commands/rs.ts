import { connectRSService } from '../rsService/launcher';
import { resolveRSServicePaths, type RSServicePaths } from '../rsService/paths';
import { SHELL_RS_CONTRACT } from '../toolkits/local/shellRS';
import { SHELL_RS_MANAGEMENT } from '../toolkits/local/shellRSService';

/**
 * `pinpawo rs <action>`: management of the standalone RS service (#853).
 *
 * This is where processes are stopped for good: RS sessions have no close
 * operation, and neither a tool call nor a Host exit ends them. Management
 * talks to a running service only; it never starts one.
 */

export type RSCommandOptions = Readonly<{
  session?: string;
  paths?: RSServicePaths;
  write?: (text: string) => void;
}>;

const ACTIONS = ['status', 'processes', 'terminate', 'stop'] as const;

export async function runRSCommand(
  action: string,
  argument: string | undefined,
  options: RSCommandOptions = {},
): Promise<void> {
  if (!(ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`Unknown rs action: ${action}. Expected one of: ${ACTIONS.join(', ')}`);
  }
  const write = options.write ?? ((text: string) => { process.stdout.write(text); });
  const print = (value: unknown) => write(`${JSON.stringify(value, null, 2)}\n`);
  const paths = options.paths ?? resolveRSServicePaths();

  const admin = await connectRSService({ paths });
  if (!admin) {
    if (action === 'status' || action === 'stop') {
      print({ running: false, endpoint: paths.endpoint });
      return;
    }
    throw new Error('The RS service is not running.');
  }
  try {
    if (action === 'status') {
      print({ running: true, endpoint: paths.endpoint, log: paths.log, ...await admin.admin('status') as object });
      return;
    }
    if (action === 'processes') {
      print(await admin.admin('manage', {
        contract: SHELL_RS_CONTRACT,
        name: SHELL_RS_MANAGEMENT.processes,
        args: options.session ? { agentSessionId: options.session } : {},
      }));
      return;
    }
    if (action === 'terminate') {
      if (!argument) throw new Error('Usage: pinpawo rs terminate <processId>');
      print(await admin.admin('manage', {
        contract: SHELL_RS_CONTRACT,
        name: SHELL_RS_MANAGEMENT.terminate,
        args: { processId: argument },
      }));
      return;
    }
    print({ stopped: true, ...await admin.admin('stop') as object });
  } finally {
    await admin.close();
  }
}
