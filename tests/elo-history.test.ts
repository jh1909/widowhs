import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('public ELO graph reads only the latest saved updates despite private table policies', async t => {
  const db = new PGlite();
  const migration = await readFile(new URL('../supabase/migrations/20261013210000_public_elo_history.sql', import.meta.url), 'utf8');
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create table public.players(name text primary key);
      create table public.player_history(id uuid primary key default gen_random_uuid(), player_name text,
        elo integer, rank integer, created_at timestamptz default now());
      alter table public.player_history enable row level security;
      create policy legacy_insert_only on public.player_history for insert with check(true);
      grant select on public.player_history to anon, authenticated;
      insert into public.players values ('Tracked'), ('Empty'), ('Tie');
      insert into public.player_history(player_name,elo,rank,created_at)
        select 'Tracked',100+n,n,'2026-10-01T00:00:00Z'::timestamptz + n*interval '1 minute' from generate_series(1,45)n;
      insert into public.player_history(player_name,elo,rank) values ('Deleted',999,1);
    `);
    await db.exec(migration);
    const asRole = async <T>(role: string, action: () => Promise<T>) => {
      await db.exec(`set role ${role}`);
      try { return await action(); } finally { await db.exec('reset role'); }
    };
    const history = (name: string, role = 'anon') => asRole(role, () => db.query<any>('select * from public.get_player_elo_history($1)', [name]));

    await t.test('anonymous and authenticated readers see the newest 30, oldest-to-newest, without IDs or ranks', async () => {
      for (const role of ['anon', 'authenticated']) {
        assert.equal((await asRole(role, () => db.query('select * from public.player_history'))).rows.length, 0);
        const rows = (await history('Tracked',role)).rows;
        assert.deepEqual(rows.map(row => row.elo), Array.from({length:30}, (_,i) => 116+i));
        assert.deepEqual(Object.keys(rows[0]).sort(), ['created_at','elo']);
        assert.ok(rows.every((row,i) => !i || new Date(row.created_at) >= new Date(rows[i-1].created_at)));
      }
    });

    await t.test('new saved points replace the oldest displayed point, including a real zero ELO', async () => {
      await db.query("insert into public.player_history(player_name,elo,created_at) values('Tracked',0,'2026-10-01T01:00:00Z')");
      const rows = (await history('Tracked')).rows;
      assert.equal(rows.length,30);
      assert.equal(rows[0].elo,117);
      assert.equal(rows.at(-1).elo,0);
    });

    await t.test('missing, empty and deleted profiles produce no fabricated rating points', async () => {
      for (const name of ['Empty','Missing','Deleted','Tracked%']) assert.deepEqual((await history(name)).rows, []);
      await db.query("insert into public.player_history(player_name,elo,created_at) values('Empty',null,now()),('Empty',100,null)");
      assert.deepEqual((await history('Empty')).rows, []);
    });

    await t.test('equal timestamps retain separate updates with deterministic ordering', async () => {
      await db.query("insert into public.player_history(id,player_name,elo,created_at) values($1,'Tie',10,'2026-10-01T00:00:00Z'),($2,'Tie',20,'2026-10-01T00:00:00Z')",[
        '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002']);
      assert.deepEqual((await history('Tie')).rows.map(row => row.elo),[10,20]);
    });

    await t.test('migration reinstall preserves data and grants no browser writes', async () => {
      const before = (await db.query('select * from public.player_history order by id')).rows;
      await db.exec(migration);
      assert.deepEqual((await db.query('select * from public.player_history order by id')).rows,before);
      for (const role of ['anon','authenticated']) {
        await assert.rejects(asRole(role, () => db.query("update public.player_history set elo=9999 where player_name='Tracked'")), (error: any) => error.code === '42501');
      }
    });
  } finally { await db.close(); }
});
