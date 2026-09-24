import type {
  ToolkitRS,
  ToolkitRSRequirement,
} from '@pinpawo/pet-agent';
import type {
  BrowserElementTarget,
  BrowserExtractOptions,
  BrowserScrollOptions,
  BrowserWaitState,
} from './session';

/**
 * BrowserRS: the page- and tab-session contract the Browser Toolkit is
 * written against.
 *
 * One Agent session maps to one BrowserRS logical session: the tabs, targets
 * and page state that session opened and still works with. The RS owns the
 * extension bridge, target/ref bookkeeping and CDP connection state; the Host
 * never copies them. This contract belongs to the current Browser Toolkit; a
 * different browser backend may become its own Toolkit with its own contract.
 */

export const BROWSER_RS_CONTRACT = 'pinpawo.browser-rs';
export const BROWSER_RS_VERSION = 1;

export const BROWSER_RS_REQUIREMENT: ToolkitRSRequirement = Object.freeze({
  contract: BROWSER_RS_CONTRACT,
  version: BROWSER_RS_VERSION,
  session: 'agent-session',
});

/**
 * Per-call context. `agentSessionId` selects the logical session and is
 * opaque to the RS; `workdir` is only this call's execution condition (where
 * a screenshot is written), not part of the session.
 */
export type BrowserRSCallContext = Readonly<{
  agentSessionId: string;
  workdir: string;
  signal?: AbortSignal;
}>;

export type BrowserRS = ToolkitRS & {
  open(context: BrowserRSCallContext, url: string): Promise<string>;
  snapshot(context: BrowserRSCallContext): Promise<string>;
  click(
    context: BrowserRSCallContext,
    target: string | BrowserElementTarget,
  ): Promise<string>;
  type(
    context: BrowserRSCallContext,
    target: string | BrowserElementTarget,
    text: string,
    submit?: boolean,
  ): Promise<string>;
  scroll(
    context: BrowserRSCallContext,
    options?: BrowserScrollOptions,
  ): Promise<string>;
  wait(
    context: BrowserRSCallContext,
    target?: string | BrowserElementTarget,
    timeoutMs?: number,
    state?: BrowserWaitState,
  ): Promise<string>;
  extract(
    context: BrowserRSCallContext,
    options?: BrowserExtractOptions,
  ): Promise<string>;
  screenshot(context: BrowserRSCallContext): Promise<string>;
  close(context: BrowserRSCallContext): Promise<string>;
};
