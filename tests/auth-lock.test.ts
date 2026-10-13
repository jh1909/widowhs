import assert from 'node:assert/strict';
import test from 'node:test';
import { GoTrueClient } from '@supabase/supabase-js';
import { browserAuthLock } from '../src/lib/auth-lock.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Model Web Locks' callback contract, including ifAvailable's null lock.
// Record callback rejections separately, as Firefox may expose those even when
// the overall request rejection is subsequently handled by the SDK.
class Locks {
  held = new Set<string>();
  callbackRejections: unknown[] = [];
  waiting = new Map<string, (() => void)[]>();
  options: LockOptions[] = [];
  async request<T>(name: string, options: LockOptions, callback: (lock: Lock | null) => T | Promise<T>): Promise<T> {
    this.options.push(options);
    if (this.held.has(name) && options.ifAvailable) {
      try { return await callback(null); }
      catch (error) { this.callbackRejections.push(error); throw error; }
    }
    while (this.held.has(name)) await new Promise<void>(resolve => {
      this.waiting.set(name, [...(this.waiting.get(name) ?? []), resolve]);
    });
    this.held.add(name);
    try { return await callback({ name, mode: 'exclusive' }); }
    catch (error) { this.callbackRejections.push(error); throw error; }
    finally {
      this.held.delete(name);
      for (const resume of this.waiting.get(name) ?? []) resume();
      this.waiting.delete(name);
    }
  }
}

async function withLocks(action: (locks: Locks) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const locks = new Locks();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  try { await action(locks); }
  finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
}

test('busy background refresh skips without rejecting the native lock callback or running without a lock', async () => withLocks(async locks => {
  locks.held.add('auth');
  let calls = 0;
  await assert.rejects(browserAuthLock('auth', 0, async () => { calls++; }), (error: any) => error.isAcquireTimeout === true);
  assert.equal(calls, 0);
  assert.deepEqual(locks.callbackRejections, []);
  assert.equal(locks.held.has('auth'), true);
  assert.deepEqual(locks.options[0], { mode: 'exclusive', ifAvailable: true });
}));

test('normal auth requests still wait and serialize with a background lock held by another tab', async () => withLocks(async locks => {
  const release = deferred();
  const started = deferred();
  const events: string[] = [];
  const first = browserAuthLock('auth', 0, async () => {
    assert.equal(locks.held.has('auth'), true);
    events.push('first'); started.resolve(); await release.promise; events.push('release'); return 1;
  });
  await started.promise;
  const second = browserAuthLock('auth', 5000, async () => { events.push('second'); return 2; });
  await Promise.resolve();
  assert.deepEqual(events, ['first']);
  release.resolve();
  assert.deepEqual(await Promise.all([first,second]), [1,2]);
  assert.deepEqual(events, ['first','release','second']);
  assert.equal(locks.options[1].mode, 'exclusive');
  assert.ok(locks.options[1].signal instanceof AbortSignal);
  assert.equal(locks.options[1].ifAvailable, undefined);
  assert.equal(locks.held.size, 0);
}));

test('real operation failures propagate and release the lock', async () => withLocks(async locks => {
  const error = new Error('refresh failed');
  await assert.rejects(browserAuthLock('auth', 0, async () => { throw error; }), value => value === error);
  assert.equal(locks.held.size, 0);
  assert.equal(await browserAuthLock('auth', 0, async () => 42), 42);
}));

test('Supabase handles a skipped auto-refresh tick and continues with the next tick', async () => withLocks(async locks => {
  const grants: string[] = [];
  const fetchMock: typeof fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://example.com');
    const grant = url.searchParams.get('grant_type')!;
    grants.push(grant);
    const seconds = grant === 'password' ? 30 : 3600;
    const payload = Buffer.from(JSON.stringify({ sub: '00000000-0000-0000-0000-000000000001', exp: Math.floor(Date.now()/1000)+seconds })).toString('base64url');
    return Response.json({ access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.test`, refresh_token: 'test-refresh-token',
      token_type: 'bearer', expires_in: seconds, user: { id: '00000000-0000-0000-0000-000000000001', aud: 'authenticated', user_metadata: {}, app_metadata: {} } });
  };
  const auth = new GoTrueClient({ url: 'https://example.com/auth/v1', storageKey: 'auth-test',
    autoRefreshToken: false, persistSession: false, detectSessionInUrl: false, lock: browserAuthLock, fetch: fetchMock });
  await auth.initialize();
  const login = await auth.signInWithPassword({ email: 'test@example.com', password: 'local-test' });
  assert.equal(login.error, null);
  assert.deepEqual(grants, ['password']);
  locks.held.add('lock:auth-test');
  await (auth as any)._autoRefreshTokenTick();
  assert.deepEqual(locks.callbackRejections, []);
  assert.deepEqual(grants, ['password']);
  locks.held.delete('lock:auth-test');
  await (auth as any)._autoRefreshTokenTick();
  assert.deepEqual(grants, ['password','refresh_token']);
  assert.equal((await auth.getSession()).error, null);
  assert.equal((await auth.getSession()).data.session?.user.id, login.data.user?.id);
  assert.equal(locks.held.size, 0);
  await auth.stopAutoRefresh();
}));
