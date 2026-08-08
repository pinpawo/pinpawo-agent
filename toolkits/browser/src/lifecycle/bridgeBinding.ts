/**
 * Production seam that binds a live `BrowserExtensionBridge` to a
 * `BrowserLifecycleController`.
 *
 * This is the piece that closes the loop between the transport layer and the
 * pure lifecycle state machine. The bridge owns the connection/target/navigation
 * generation counters and emits normalized runtime events; the controller owns
 * the navigation phase machine and staleness rules. This module is the small,
 * explicit adapter that wires the two together:
 *
 * - `bridge.onRuntimeEvent(...)`     → `controller.handleEvent(...)`
 * - `bridge.onGenerationChanged(...)` → `controller.notifyGenerationAdvance(...)`
 *
 * Subscribing to `onGenerationChanged` is the key requirement from the #583
 * review: without it, `notifyGenerationAdvance` has no production caller, so a
 * reconnect (`replaceActiveSocket` bumps `connectionGeneration`) or a managed
 * target close (`target.closed` bumps `targetGeneration`) would leave an
 * in-flight navigation hanging silently until its deadline instead of failing
 * deterministically. The bridge knows exactly when these counters bump, and it
 * now fans that out; this adapter turns it into a deterministic controller
 * `runtime_disconnected` / `target_closed` failure.
 *
 * It is framework- and I/O-free beyond the two subscriptions: the binding does
 * not start/stop the bridge or perform any navigation itself. Callers
 * (the session/driver, or a test) own the bridge lifecycle and pass the two
 * objects in.
 */
import type { BrowserLifecycleController } from './controller';
import type { BrowserRuntimeEvent } from './events';

export type GenerationChange = {
  connectionGeneration: number;
  targetGeneration: number;
};

/** The bridge surface this binding needs, kept narrow for testability. */
export type RuntimeEventSource = {
  onRuntimeEvent(listener: (event: BrowserRuntimeEvent) => void): () => void;
  onGenerationChanged(listener: (change: GenerationChange) => void): () => void;
};

/**
 * Bind a bridge/event source to a lifecycle controller. Returns an unsubscribe
 * function that removes both subscriptions, so the driver can tear the binding
 * down when it stops.
 */
export function bindBridgeToController(
  source: RuntimeEventSource,
  controller: BrowserLifecycleController,
): () => void {
  const offEvents = source.onRuntimeEvent((event) => {
    controller.handleEvent(event);
  });
  const offGenerations = source.onGenerationChanged((change) => {
    controller.notifyGenerationAdvance(
      change.connectionGeneration,
      change.targetGeneration,
    );
  });
  return () => {
    offEvents();
    offGenerations();
  };
}
