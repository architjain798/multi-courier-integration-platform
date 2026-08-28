import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestContext = {
  requestId: string;
  attempt: number;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId, attempt: 1 }, fn);
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function getAttempt(): number {
  return storage.getStore()?.attempt ?? 1;
}

// The retry decorator sits outside the audit decorator, so the attempt number cannot be passed
// down the call chain. It is stamped on the ambient context instead.
export function setAttempt(attempt: number): void {
  const store = storage.getStore();
  if (store !== undefined) {
    store.attempt = attempt;
  }
}
