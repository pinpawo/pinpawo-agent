import type {
  BrowserElementTarget,
  BrowserExtractOptions,
  BrowserOpenOptions,
  BrowserScrollOptions,
  BrowserWaitState,
} from './session';

export type BrowserRuntimeCallContext = Readonly<{
  threadId: string;
  workdir: string;
  signal?: AbortSignal;
}>;

/**
 * Browser operations visible to Tool implementations.
 *
 * The port accepts generic invocation context on every call. Session lookup,
 * ownership, backend selection, and resource lifecycle remain Browser Runtime
 * implementation details.
 */
export type BrowserRuntimePort = {
  open(
    context: BrowserRuntimeCallContext,
    url: string,
    options?: BrowserOpenOptions,
  ): Promise<string>;
  openWithProfile(
    context: BrowserRuntimeCallContext,
    url: string,
    userDataDir: string,
    options?: Omit<BrowserOpenOptions, 'session' | 'userDataDir'>,
  ): Promise<string>;
  snapshot(context: BrowserRuntimeCallContext): Promise<string>;
  click(
    context: BrowserRuntimeCallContext,
    target: string | BrowserElementTarget,
  ): Promise<string>;
  type(
    context: BrowserRuntimeCallContext,
    target: string | BrowserElementTarget,
    text: string,
    submit?: boolean,
  ): Promise<string>;
  scroll(
    context: BrowserRuntimeCallContext,
    options?: BrowserScrollOptions,
  ): Promise<string>;
  wait(
    context: BrowserRuntimeCallContext,
    target?: string | BrowserElementTarget,
    timeoutMs?: number,
    state?: BrowserWaitState,
  ): Promise<string>;
  extract(
    context: BrowserRuntimeCallContext,
    options?: BrowserExtractOptions,
  ): Promise<string>;
  screenshot(context: BrowserRuntimeCallContext): Promise<string>;
  close(context: BrowserRuntimeCallContext): Promise<string>;
  listSessions(context: BrowserRuntimeCallContext): Promise<string[]>;
};

const BROWSER_RUNTIME_METHODS = [
  'open',
  'openWithProfile',
  'snapshot',
  'click',
  'type',
  'scroll',
  'wait',
  'extract',
  'screenshot',
  'close',
  'listSessions',
] as const satisfies readonly (keyof BrowserRuntimePort)[];

export function isBrowserRuntimePort(value: unknown): value is BrowserRuntimePort {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Record<keyof BrowserRuntimePort, unknown>>;
  return BROWSER_RUNTIME_METHODS.every(
    (method) => typeof candidate[method] === 'function',
  );
}
