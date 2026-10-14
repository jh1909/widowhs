import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { boundedDatabaseRequest, checkDatabase, databaseCount } from '../src/lib/database-status.ts';

const success = { status: 200, error: null };

test('a successful slow query remains reachable and reports measured duration/time', async () => {
  const times = [10, 1260];
  const result = await checkDatabase(async () => success, { clock: () => times.shift()!, timestamp: () => 12345 });
  assert.deepEqual(result, { state: 'reachable', responseMs: 1250, checkedAt: 12345, httpStatus: 200, message: null });
});

test('fast HTTP failures and permission failures never look healthy', async () => {
  for (const [status, state] of [[401,'denied'],[403,'denied'],[500,'error'],[0,'error']] as const) {
    const result = await checkDatabase(async () => ({ status, error: { message: 'Request rejected' } }), { clock: () => 0 });
    assert.equal(result.state, state);
    assert.equal(result.httpStatus, status || null);
    assert.equal(result.message, 'Request rejected');
  }
  assert.equal((await checkDatabase(async () => ({ status: 503, error: null }))).state, 'error');
});

test('offline is a browser observation and does not call the database', async () => {
  let queried = false;
  const result = await checkDatabase(async () => { queried = true; return success; }, { online: false });
  assert.equal(queried, false);
  assert.equal(result.state, 'offline');
  assert.equal(result.responseMs, null);
  assert.match(result.message!, /availability is unknown/);
});

test('network exceptions surface as request failures', async () => {
  const result = await checkDatabase(async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(result.state, 'error');
  assert.equal(result.message, 'Failed to fetch');
  assert.equal(result.httpStatus, null);
});

test('timeout wins over the aborted fetch response and cancels the underlying request', async () => {
  let signal: AbortSignal | undefined;
  const result = await checkDatabase(abort => new Promise((_, reject) => {
    signal = abort;
    abort.addEventListener('abort', () => reject(new DOMException('Aborted fetch', 'AbortError')));
  }), { timeoutMs: 5 });
  assert.equal(result.state, 'timeout');
  assert.equal(signal?.aborted, true);
  assert.match(result.message!, /0.005 seconds/);
});

test('a stuck SDK operation that ignores cancellation is still bounded and late success is ignored', async () => {
  let resolve!: (reply: typeof success) => void;
  let signal: AbortSignal | undefined;
  const result = await checkDatabase(abort => {
    signal = abort;
    return new Promise(done => { resolve = done; });
  }, { timeoutMs: 5 });
  assert.equal(result.state, 'timeout');
  assert.equal(signal?.aborted, true);
  resolve(success);
  await Promise.resolve();
  assert.equal(result.state, 'timeout');
});

test('cleanup cancellation stops requests without being counted as a database failure', async () => {
  const parent = new AbortController();
  parent.abort();
  let queried = false;
  const result = await checkDatabase(async () => { queried = true; return success; }, { signal: parent.signal });
  assert.equal(queried, false);
  assert.equal(result.state, 'cancelled');
  const second = new AbortController();
  const pending = checkDatabase(abort => new Promise((_, reject) => {
    abort.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
    second.abort();
  }), { signal: second.signal });
  assert.equal((await pending).state, 'cancelled');
});

test('zero is a valid count; failed, missing or invalid counts cannot become zero', () => {
  assert.equal(databaseCount({ ...success, count: 0 }), 0);
  assert.equal(databaseCount({ ...success, count: 1234 }), 1234);
  for (const count of [null, -1, .5, NaN, Infinity]) assert.throws(() => databaseCount({ ...success, count }));
  assert.throws(() => databaseCount({ status: 403, error: { message: 'Permission denied' }, count: 0 }), /Permission denied/);
  assert.throws(() => databaseCount({ status: 500, error: null, count: 0 }));
});

test('the real SDK reports denied queries and preserves empty HEAD counts', async () => {
  const client = createClient('https://example.supabase.co', 'public-test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (url, options) => {
      assert.match(String(url), /\/rest\/v1\/players/);
      assert.ok(options?.signal instanceof AbortSignal);
      if (options?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': '*/0' } });
      return Response.json({ message: 'Permission denied', code: '42501' }, { status: 403 });
    } },
  });
  assert.equal((await checkDatabase(signal => client.from('players').select('name').limit(1).abortSignal(signal))).state, 'denied');
  const count = await boundedDatabaseRequest(signal => client.from('players').select('name', { count: 'exact', head: true }).abortSignal(signal));
  assert.equal(databaseCount(count), 0);
});
