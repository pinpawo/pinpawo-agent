import type { ServerPeer } from './wire/peer';

/**
 * Preserve wire arrival order for checkpoint-backed session commands without
 * serializing long-running agent execution or delaying interrupts.
 */
export class ServerSessionCommandQueue {
  private readonly tails = new WeakMap<ServerPeer, Promise<void>>();

  enqueue(peer: ServerPeer, command: () => Promise<void>) {
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

  waitForIdle(peer: ServerPeer) {
    const current = this.tails.get(peer);
    return current
      ? current.then(() => undefined, () => undefined)
      : Promise.resolve();
  }

  clear(peer: ServerPeer) {
    this.tails.delete(peer);
  }
}
