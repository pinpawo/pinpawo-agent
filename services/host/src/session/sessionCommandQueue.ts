import { ResidentPetOperationCancelledError } from '../host/contracts';

/**
 * Serializes the commands a client issues.
 *
 * These are the server side of the TUI's slash commands — `/new`, `/resume`,
 * `/compact`, `/model`, `/policy`, `/refresh` — plus the listings each one
 * opens with (`session.list`, `model.list`). A human message is not a command
 * and does not queue here; it waits for the queue to drain and is then
 * admitted by SessionAdmission.
 *
 * A transport delivers messages in arrival order but does not await each
 * handler — WebSocket and stdio both call `onMessage` with `void` — so two
 * commands typed in quick succession would otherwise overlap. Commands that
 * change state are additionally serialized by SessionAdmission; this queue is
 * what keeps a listing ordered against them, so `/resume`'s session list
 * cannot be read halfway through a `/new`.
 *
 * The queue is Host-wide rather than per connection: a Host admits one
 * interactive client, so there is one stream of commands to order.
 */
export class SessionCommandQueue {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  /** Run `command` after everything already queued has settled. */
  enqueue(command: () => Promise<void>): Promise<void> {
    // The tail follows settlement rather than the value, so one failed
    // command does not block every command after it.
    const next = this.tail.then(() => {
      this.assertOpen();
      return command();
    });
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Resolve once the queued commands have settled. */
  async waitForIdle(): Promise<void> {
    await this.tail;
    this.assertOpen();
  }

  /** Refuse future/queued commands without interrupting the executing one. */
  close(): void {
    this.closed = true;
  }

  assertOpen(): void {
    if (this.closed) throw new ResidentPetOperationCancelledError('Resident Pet Host is closing.');
  }
}
