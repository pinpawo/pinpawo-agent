import {
  BROWSER_RS_CONTRACT,
  BROWSER_RS_VERSION,
  type BrowserRSCallContext,
  ChromeExtensionBrowserRS,
} from '@pinpawo-toolkit/browser';
import type { RSServiceHandler } from '../rsService/server';
import { RSServiceError } from '../rsService/transport';

/**
 * BrowserRS served by the RS service (#862).
 *
 * The wire shape of each operation is its `BrowserRS` signature, with the
 * call context reduced to data (`agentSessionId`, `workdir`) and its signal
 * replaced by the transport's cancellation. Browser errors keep their `code`,
 * `retryable` and `details` across the transport.
 */

function invalid(message: string): never {
  throw new RSServiceError('invalid_request', message);
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`Invalid ${field}.`);
  return value as Record<string, unknown>;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) invalid(`Invalid ${field}.`);
  return value;
}

function readContext(value: unknown, signal: AbortSignal): BrowserRSCallContext {
  const context = readRecord(value, 'context');
  return {
    agentSessionId: readString(context.agentSessionId, 'context.agentSessionId'),
    workdir: readString(context.workdir, 'context.workdir'),
    signal,
  };
}

/** Optional fields are passed through as given; the BrowserRS validates them. */
function optional<T>(value: unknown): T | undefined {
  return value === undefined || value === null ? undefined : value as T;
}

export function createBrowserRSServiceHandler(
  rs: ChromeExtensionBrowserRS = new ChromeExtensionBrowserRS(),
): RSServiceHandler {
  return {
    contract: BROWSER_RS_CONTRACT,
    version: BROWSER_RS_VERSION,
    async call(method, args, { signal }) {
      if (method === 'status') {
        // A bridge that could not start (say another process held its socket)
        // is retried whenever a Host asks, so it recovers once the socket is
        // free instead of waiting for a call no Host will make while the
        // Browser Toolkit is unavailable.
        if (!rs.status().available) await rs.start().catch(() => undefined);
        return rs.status();
      }
      const input = readRecord(args, 'arguments');
      if (method === 'ensureSession') {
        rs.ensureSession(readString(input.agentSessionId, 'agentSessionId'));
        return null;
      }
      const context = readContext(input.context, signal);
      switch (method) {
        case 'open':
          return await rs.open(context, readString(input.url, 'url'));
        case 'snapshot':
          return await rs.snapshot(context);
        case 'click':
          return await rs.click(context, input.target as never);
        case 'type':
          return await rs.type(
            context,
            input.target as never,
            typeof input.text === 'string' ? input.text : invalid('Invalid text.'),
            optional<boolean>(input.submit),
          );
        case 'scroll':
          return await rs.scroll(context, optional(input.options));
        case 'wait':
          return await rs.wait(
            context,
            optional(input.target),
            optional<number>(input.timeoutMs),
            optional(input.state),
          );
        case 'extract':
          return await rs.extract(context, optional(input.options));
        case 'screenshot':
          return await rs.screenshot(context);
        case 'close':
          return await rs.close(context);
        default:
          return invalid(`Unknown BrowserRS operation: ${method}`);
      }
    },
    describe() {
      const { extension } = rs.getSnapshot();
      return {
        sessions: rs.sessionCount,
        openSessions: rs.openSessionCount,
        extension: extension.state,
        commandReady: extension.commandReady,
      };
    },
    // A session with a page open would lose its context and element refs if
    // the service were replaced, so it counts as work in progress.
    busy() {
      return rs.openSessionCount > 0;
    },
    async dispose() {
      const openSessions = rs.openSessionCount;
      await rs.dispose();
      return { closedSessions: openSessions };
    },
  };
}
