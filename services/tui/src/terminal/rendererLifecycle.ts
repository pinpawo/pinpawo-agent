export type SuspendableRenderer = {
  suspend: () => void;
  resume: () => void;
};

export async function withRendererSuspended<T>(
  renderer: SuspendableRenderer,
  operation: () => Promise<T>,
): Promise<T> {
  renderer.suspend();
  try {
    return await operation();
  } finally {
    renderer.resume();
  }
}
