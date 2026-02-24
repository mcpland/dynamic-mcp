export interface DynamicRegistryChangeEvent {
  originId: string;
  action: 'create' | 'update' | 'delete' | 'enable' | 'disable';
  target?: string;
  timestamp: string;
}

type DynamicRegistryChangeListener = (event: DynamicRegistryChangeEvent) => void;

const listeners = new Set<DynamicRegistryChangeListener>();

export function publishDynamicRegistryChange(
  event: Omit<DynamicRegistryChangeEvent, 'timestamp'>
): void {
  const payload: DynamicRegistryChangeEvent = {
    ...event,
    timestamp: new Date().toISOString()
  };

  for (const listener of [...listeners]) {
    queueMicrotask(() => {
      try {
        listener(payload);
      } catch {
        // Listener failures are isolated from publisher flow.
      }
    });
  }
}

export function subscribeDynamicRegistryChanges(
  listener: DynamicRegistryChangeListener
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
