import type { LocalServerPeer } from './localServerPeer';

/**
 * Preserve wire arrival order for checkpoint-backed session commands without
 * serializing long-running agent execution or delaying interrupts.
 */
export class LocalServerSessionCommandQueue {
  private readonly tails = new WeakMap<LocalServerPeer, Promise<void>>();

  enqueue(peer: LocalServerPeer, command: () => Promise<void>) {
    const previous = this.waitForIdle(peer);
    const current = previous.then(command);
    this.tails.set(peer, current);
    const clear = () => {
      if (this.tails.get(peer) === current) {
        this.tails.delete(peer);
      }
    };
    void current.then(clear, clear);
    return current;
  }

  waitForIdle(peer: LocalServerPeer) {
    const current = this.tails.get(peer);
    return current
      ? current.then(() => undefined, () => undefined)
      : Promise.resolve();
  }

  clear(peer: LocalServerPeer) {
    this.tails.delete(peer);
  }
}
