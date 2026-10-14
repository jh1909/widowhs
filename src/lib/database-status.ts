export type DatabaseReply = { status: number; error: { message: string } | null };
export type DatabaseCheck = {
  state: 'reachable' | 'offline' | 'timeout' | 'denied' | 'error' | 'cancelled';
  responseMs: number | null; checkedAt: number; httpStatus: number | null; message: string | null;
};

export class RequestTimeoutError extends Error {
  constructor(timeoutMs = 10000) { super(`The database request timed out after ${timeoutMs / 1000} seconds.`); this.name = 'RequestTimeoutError'; }
}

// Bound the entire request, including SDK session lookup before fetch starts.
// Forward cancellation to PostgREST and stop observing late results.
export async function boundedDatabaseRequest<T>(
  request: (signal: AbortSignal) => PromiseLike<T>,
  parentSignal?: AbortSignal,
  timeoutMs = 10000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(new DOMException('Request cancelled', 'AbortError'));
        controller.abort();
      };
      if (parentSignal?.aborted) { onAbort(); return; }
      parentSignal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        reject(new RequestTimeoutError(timeoutMs));
        controller.abort();
      }, timeoutMs);
    });
    if (controller.signal.aborted) return await stopped;
    return await Promise.race([stopped, Promise.resolve().then(() => request(controller.signal))]);
  } finally {
    clearTimeout(timer);
    if (onAbort) parentSignal?.removeEventListener('abort', onAbort);
  }
}

export async function checkDatabase(
  request: (signal: AbortSignal) => PromiseLike<DatabaseReply>,
  { signal, online = true, timeoutMs = 10000, clock = () => performance.now(), timestamp = () => Date.now() }: {
    signal?: AbortSignal; online?: boolean; timeoutMs?: number; clock?: () => number; timestamp?: () => number;
  } = {},
): Promise<DatabaseCheck> {
  if (!online) return { state: 'offline', responseMs: null, checkedAt: timestamp(), httpStatus: null,
    message: 'Your browser reports that it is offline. Database availability is unknown.' };
  const started = clock();
  try {
    const reply = await boundedDatabaseRequest(request, signal, timeoutMs);
    const responseMs = Math.max(0, Math.round(clock() - started));
    const httpStatus = reply.status > 0 ? reply.status : null;
    if (!reply.error && reply.status >= 200 && reply.status < 300)
      return { state: 'reachable', responseMs, checkedAt: timestamp(), httpStatus, message: null };
    return { state: reply.status === 401 || reply.status === 403 ? 'denied' : 'error',
      responseMs, checkedAt: timestamp(), httpStatus, message: reply.error?.message || 'The database request failed.' };
  } catch (error) {
    return { state: signal?.aborted ? 'cancelled' : error instanceof RequestTimeoutError ? 'timeout' : 'error',
      responseMs: null, checkedAt: timestamp(), httpStatus: null,
      message: error instanceof Error ? error.message : 'The database request failed.' };
  }
}

export function databaseCount(reply: DatabaseReply & { count: number | null }): number {
  if (reply.error || reply.status < 200 || reply.status >= 300) throw new Error(reply.error?.message || 'Count request failed.');
  if (!Number.isSafeInteger(reply.count) || reply.count === null || reply.count < 0) throw new Error('The database did not return a valid count.');
  return reply.count;
}
