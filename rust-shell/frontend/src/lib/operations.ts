export class OperationTimeout extends Error {}

export interface OperationOptions<T> {
  signal?: AbortSignal;
  timeoutMs?: number;
  onTimeout?: () => void;
  onLateResult?: (value: T) => void | Promise<void>;
}

// A deadline bounds the UI wait, not the server mutation. Never replay here.
export function runOperation<T>(promise: PromiseLike<T>, label: string, options: OperationOptions<T> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      action();
    };
    const abort = () => finish(() => reject(new Error(`${label}: connection or session changed.`)));
    const timer = setTimeout(() => {
      finish(() => reject(new OperationTimeout(`${label} timed out.`)));
      options.onTimeout?.();
    }, options.timeoutMs ?? 10000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    Promise.resolve(promise).then(value => {
      if (settled) {
        void Promise.resolve().then(() => options.onLateResult?.(value)).catch(() => {});
      } else finish(() => resolve(value));
    }, error => finish(() => reject(error)));
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
