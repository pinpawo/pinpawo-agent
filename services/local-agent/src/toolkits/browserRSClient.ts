import type { ToolkitAvailability } from '@pinpawo/pet-agent';
import {
  BROWSER_RS_CONTRACT,
  BROWSER_RS_VERSION,
  type BrowserElementTarget,
  type BrowserExtractOptions,
  type BrowserRS,
  type BrowserRSCallContext,
  type BrowserScrollOptions,
  type BrowserWaitState,
} from '@pinpawo-toolkit/browser';
import type { RSServiceConnection } from '../rsService/connection';
import { type RSCallFailure, RSContractClient } from '../rsService/contractClient';
import type { RSServicePaths } from '../rsService/paths';
import { RSServiceError } from '../rsService/transport';

export type BrowserRSClientOptions = Readonly<{
  paths?: RSServicePaths;
  /** How to reach the service; defaults to starting it when none runs. */
  connect?: () => Promise<RSServiceConnection>;
  /** Overridable so the Windows path can be tested anywhere. */
  platform?: NodeJS.Platform;
}>;

const WINDOWS_UNAVAILABLE = 'The RS service does not run on Windows yet (#855); the Browser Toolkit is unavailable.';

/**
 * Browser failures carry `code`, `retryable` and `details`, which the Browser
 * Tools turn into the structured error the model recovers from. Transport
 * failures get Browser codes of their own.
 */
function toBrowserError(failure: RSCallFailure): Error {
  if (failure.kind === 'unavailable') {
    return new RSServiceError('runtime_disconnected', failure.message, true);
  }
  if (failure.kind === 'result_unknown') {
    return new RSServiceError(
      'result_unknown',
      'Lost the RS service while this browser operation was running; whether it took effect is unknown'
      + ' and it was not retried. Take a new browser_snapshot before deciding what to do next.',
      false,
      { resultUnknown: true },
    );
  }
  return failure.error;
}

/** The call context as data: its signal travels as transport cancellation. */
function wireContext(context: BrowserRSCallContext) {
  return { agentSessionId: context.agentSessionId, workdir: context.workdir };
}

/**
 * The Host's connection to BrowserRS.
 *
 * BrowserRS runs only in the RS service, where `ChromeExtensionBrowserRS`
 * holds the one extension bridge and every logical session. This client is
 * transport, not a second kind of BrowserRS: the Browser Toolkit cannot tell
 * it from the implementation. This Host disconnecting, or exiting, leaves the
 * sessions and their pages in place for a later Host with the same Agent
 * session.
 */
export class BrowserRSClient implements BrowserRS {
  readonly contract = BROWSER_RS_CONTRACT;
  readonly version = BROWSER_RS_VERSION;

  private readonly transport: RSContractClient;

  constructor(options: BrowserRSClientOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.transport = new RSContractClient({
      rs: { contract: BROWSER_RS_CONTRACT, version: BROWSER_RS_VERSION },
      label: 'BrowserRS',
      ...(options.paths ? { paths: options.paths } : {}),
      ...(options.connect ? { connect: options.connect } : {}),
      ...(platform === 'win32' ? { unsupportedReason: WINDOWS_UNAVAILABLE } : {}),
      toError: toBrowserError,
    });
  }

  /** Host startup: reach the service now so failures surface as status. */
  async start(): Promise<void> {
    await this.transport.start();
  }

  async status(): Promise<ToolkitAvailability> {
    return await this.transport.status();
  }

  async ensureSession(agentSessionId: string): Promise<void> {
    await this.transport.call('ensureSession', { agentSessionId });
  }

  async open(context: BrowserRSCallContext, url: string): Promise<string> {
    return await this.operation('open', context, { url });
  }

  async snapshot(context: BrowserRSCallContext): Promise<string> {
    return await this.operation('snapshot', context, {});
  }

  async click(context: BrowserRSCallContext, target: string | BrowserElementTarget): Promise<string> {
    return await this.operation('click', context, { target });
  }

  async type(
    context: BrowserRSCallContext,
    target: string | BrowserElementTarget,
    text: string,
    submit?: boolean,
  ): Promise<string> {
    return await this.operation('type', context, { target, text, submit });
  }

  async scroll(context: BrowserRSCallContext, options?: BrowserScrollOptions): Promise<string> {
    return await this.operation('scroll', context, { options });
  }

  async wait(
    context: BrowserRSCallContext,
    target?: string | BrowserElementTarget,
    timeoutMs?: number,
    state?: BrowserWaitState,
  ): Promise<string> {
    return await this.operation('wait', context, { target, timeoutMs, state });
  }

  async extract(context: BrowserRSCallContext, options?: BrowserExtractOptions): Promise<string> {
    return await this.operation('extract', context, { options });
  }

  async screenshot(context: BrowserRSCallContext): Promise<string> {
    return await this.operation('screenshot', context, {});
  }

  async close(context: BrowserRSCallContext): Promise<string> {
    return await this.operation('close', context, {});
  }

  /**
   * Close this Host's connection. The service, its sessions and their pages
   * stay; stopping them is the service's own management.
   */
  async dispose(): Promise<void> {
    await this.transport.dispose();
  }

  private async operation(
    method: string,
    context: BrowserRSCallContext,
    params: Record<string, unknown>,
  ): Promise<string> {
    return await this.transport.call(
      method,
      { ...params, context: wireContext(context) },
      context.signal,
    ) as string;
  }
}
