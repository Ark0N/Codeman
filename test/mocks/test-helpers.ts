/**
 * Reusable async test helpers.
 * Extracted from respawn-test-utils.ts.
 */

/** Wait for an EventEmitter to emit a specific event, with timeout */
export function waitForEvent(
  emitter: { once: (event: string, listener: (...args: unknown[]) => void) => void },
  event: string,
  timeoutMs = 5000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for event "${event}" after ${timeoutMs}ms`)),
      timeoutMs,
    );
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args.length === 1 ? args[0] : args);
    });
  });
}

/** Create a deferred promise with external resolve/reject */
export function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
