import { navigatorLock, NavigatorLockAcquireTimeoutError } from '@supabase/supabase-js';

// Supabase's background refresh uses a non-blocking lock (timeout 0). Report
// normal contention outside the browser callback: Firefox can expose callback
// rejections in the console even though Auth subsequently handles the timeout.
// Waiting auth operations keep the SDK's normal timeout/recovery behaviour.
export async function browserAuthLock<R>(name: string, acquireTimeout: number, fn: () => Promise<R>): Promise<R> {
  if (acquireTimeout !== 0) return navigatorLock(name, acquireTimeout, fn);
  const result = await navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) return { acquired: false as const };
    return { acquired: true as const, value: await fn() };
  });
  if (!result.acquired) throw new NavigatorLockAcquireTimeoutError(`Auth lock "${name}" is currently busy`);
  return result.value;
}
