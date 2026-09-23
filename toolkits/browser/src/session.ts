import type { BrowserExtractOptions } from './snapshotPayload';
import type { ChromeExtensionBrowserSession } from './drivers/chromeExtension/session';
import { BrowserOperationError } from './errors';
import {
  BrowserContextOwnership,
  type BrowserExecutionOwner,
} from './ownership';

export {
  buildBrowserExtractPayload,
  buildBrowserSnapshotPayload,
  buildBrowserTextChunk,
} from './snapshotPayload';
export type { BrowserExtractOptions } from './snapshotPayload';

export type BrowserElementTarget = {
  selector?: string;
  ref?: string;
};

export type BrowserScrollOptions = {
  deltaX?: number;
  deltaY?: number;
  target?: BrowserElementTarget;
};

export type BrowserWaitState = 'visible' | 'hidden';

function throwIfBrowserOperationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new BrowserOperationError(
    'browser_command_cancelled',
    'Browser command was cancelled.',
    true,
  );
}

type ChromeExtensionSessionFactory = () => ChromeExtensionBrowserSession;

/**
 * One thread's Browser workspace, driven through the Chrome extension.
 *
 * The extension session is created on first use; execution ownership, when
 * required, serializes operations and rejects callers that do not own the
 * workspace.
 */
export class BrowserSession {
  private impl: ChromeExtensionBrowserSession | null = null;
  private readonly ownership: BrowserContextOwnership | null;
  private readonly createChromeExtensionSession: ChromeExtensionSessionFactory;

  constructor(options: {
    requireExecutionOwner?: boolean;
    createChromeExtensionSession: ChromeExtensionSessionFactory;
  }) {
    this.ownership = options.requireExecutionOwner
      ? new BrowserContextOwnership()
      : null;
    this.createChromeExtensionSession = options.createChromeExtensionSession;
  }

  private ensureImpl(): ChromeExtensionBrowserSession {
    this.impl ??= this.createChromeExtensionSession();
    return this.impl;
  }

  async open(
    url: string,
    owner: BrowserExecutionOwner | null = null,
    signal?: AbortSignal,
  ) {
    const operation = async () => {
      throwIfBrowserOperationAborted(signal);
      return this.ensureImpl().open(url, signal);
    };
    return this.ownership
      ? this.ownership.runOpen(owner, operation, signal)
      : operation();
  }
  async snapshot(owner: BrowserExecutionOwner | null = null, signal?: AbortSignal) {
    const operation = async () => {
      throwIfBrowserOperationAborted(signal);
      return this.ensureImpl().snapshot(signal);
    };
    return this.ownership
      ? this.ownership.runOwned(owner, operation, signal)
      : operation();
  }
  async click(
    target: string | BrowserElementTarget,
    owner: BrowserExecutionOwner | null = null,
    signal?: AbortSignal,
  ) {
    const operation = async () => {
      throwIfBrowserOperationAborted(signal);
      return this.ensureImpl().click(target, signal);
    };
    return this.ownership
      ? this.ownership.runOwned(owner, operation, signal)
      : operation();
  }
  async type(
    target: string | BrowserElementTarget,
    text: string,
    submit?: boolean,
    owner: BrowserExecutionOwner | null = null,
    signal?: AbortSignal,
  ) {
    const operation = async () => {
      throwIfBrowserOperationAborted(signal);
      return this.ensureImpl().type(target, text, submit, signal);
    };
    return this.ownership
      ? this.ownership.runOwned(owner, operation, signal)
      : operation();
  }
  async scroll(
    options?: BrowserScrollOptions,
    owner: BrowserExecutionOwner | null = null,
    signal?: AbortSignal,
  ) {
    const operation = async () => {
      throwIfBrowserOperationAborted(signal);
      return this.ensureImpl().scroll(options, signal);
    };
    return this.ownership
      ? this.ownership.runOwned(owner, operation, signal)
      : operation();
  }
  async wait(
    target?: string | BrowserElementTarget,
    timeoutMs?: number,
    state?: BrowserWaitState,
    owner: BrowserExecutionOwner | null = null,
    signal?: AbortSignal,
  ) {
    const operation = async () => {
      throwIfBrowserOperationAborted(signal);
      return this.ensureImpl().wait(target, timeoutMs, state, signal);
    };
    return this.ownership
      ? this.ownership.runOwned(owner, operation, signal)
      : operation();
  }
  async extract(
    options?: BrowserExtractOptions,
    owner: BrowserExecutionOwner | null = null,
    signal?: AbortSignal,
  ) {
    const operation = async () => {
      throwIfBrowserOperationAborted(signal);
      return this.ensureImpl().extract(options, signal);
    };
    return this.ownership
      ? this.ownership.runOwned(owner, operation, signal)
      : operation();
  }
  async screenshot(owner: BrowserExecutionOwner | null = null, signal?: AbortSignal) {
    const operation = async () => {
      throwIfBrowserOperationAborted(signal);
      return this.ensureImpl().screenshot(signal);
    };
    return this.ownership
      ? this.ownership.runOwned(owner, operation, signal)
      : operation();
  }
  async close(owner: BrowserExecutionOwner | null = null, signal?: AbortSignal) {
    const operation = async () => {
      throwIfBrowserOperationAborted(signal);
      return this.closeImpl(signal);
    };
    return this.ownership
      ? this.ownership.closeOwned(owner, operation, signal)
      : operation();
  }
  async shutdown() {
    const operation = async () => this.closeImpl();
    return this.ownership
      ? this.ownership.shutdown(operation)
      : operation();
  }
  private async closeImpl(signal?: AbortSignal) {
    const impl = this.impl;
    if (!impl) return 'browser session closed';
    try {
      return await impl.close(signal);
    } finally {
      this.impl = null;
    }
  }
}
