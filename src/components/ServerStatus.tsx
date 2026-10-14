import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { boundedDatabaseRequest, checkDatabase, databaseCount, type DatabaseCheck } from '../lib/database-status';

type CountState = { value: number | null; error: string | null };
const unknownCount = (): CountState => ({ value: null, error: null });
const labels: Record<DatabaseCheck['state'], { text: string; colour: string }> = {
  reachable: { text: 'Reachable', colour: 'bg-emerald-400' },
  offline: { text: 'Browser offline', colour: 'bg-amber-400' },
  timeout: { text: 'Timed out', colour: 'bg-amber-400' },
  denied: { text: 'Access denied', colour: 'bg-amber-400' },
  error: { text: 'Request failed', colour: 'bg-red-400' },
  cancelled: { text: 'Check cancelled', colour: 'bg-zinc-500' },
};
function time(value: number | null) {
  return value === null ? '—' : new Date(value).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
}

export default function ServerStatus() {
  const [check, setCheck] = useState<DatabaseCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastSuccess, setLastSuccess] = useState<number | null>(null);
  const [requests, setRequests] = useState({ successful: 0, total: 0 });
  const [counts, setCounts] = useState({ players: unknownCount(), banned: unknownCount(), logs: unknownCount() });
  const [countsAt, setCountsAt] = useState<number | null>(null);
  const checkNow = useRef<() => void>(() => {});

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let recheckRequested = false;
    let lastCountAttempt = -Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;

    const run = async (refreshCounts = false) => {
      if (!active || document.hidden) return;
      if (inFlight) { recheckRequested = true; return; }
      clearTimeout(timer);
      inFlight = true;
      recheckRequested = false;
      controller = new AbortController();
      const signal = controller.signal;
      setChecking(true);
      try {
        const result = await checkDatabase(
          abort => supabase.from('players').select('name').limit(1).abortSignal(abort),
          { signal, online: navigator.onLine },
        );
        if (!active || result.state === 'cancelled') return;
        setCheck(result);
        if (result.state !== 'offline') setRequests(previous => ({
          total: previous.total + 1, successful: previous.successful + (result.state === 'reachable' ? 1 : 0),
        }));
        if (result.state === 'reachable') {
          setLastSuccess(result.checkedAt);
          if (refreshCounts || performance.now() - lastCountAttempt >= 60000) {
            lastCountAttempt = performance.now();
            const readCount = async (request: (abort: AbortSignal) => PromiseLike<Parameters<typeof databaseCount>[0]>): Promise<CountState> => {
              try { return { value: databaseCount(await boundedDatabaseRequest(request, signal)), error: null }; }
              catch (error) { return { value: null, error: error instanceof Error ? error.message : 'Count unavailable' }; }
            };
            const [players, banned, logs] = await Promise.all([
              readCount(abort => supabase.from('players').select('name', { count: 'exact', head: true }).abortSignal(abort)),
              readCount(abort => supabase.from('players').select('name', { count: 'exact', head: true }).eq('is_banned', true).abortSignal(abort)),
              readCount(abort => supabase.from('audit_logs').select('*', { count: 'exact', head: true }).abortSignal(abort)),
            ]);
            if (!active || signal.aborted) return;
            setCounts({ players, banned, logs });
            setCountsAt(Date.now());
          }
        }
      } finally {
        inFlight = false;
        if (active) {
          setChecking(false);
          if (!document.hidden) timer = setTimeout(() => void run(recheckRequested), recheckRequested ? 0 : 15000);
        }
      }
    };
    checkNow.current = () => { void run(true); };
    const onVisibility = () => {
      clearTimeout(timer);
      if (document.hidden) controller?.abort();
      else void run(true);
    };
    const onNetworkChange = () => { controller?.abort(); void run(true); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onNetworkChange);
    window.addEventListener('offline', onNetworkChange);
    void run(true);
    return () => {
      active = false;
      clearTimeout(timer);
      controller?.abort();
      checkNow.current = () => {};
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onNetworkChange);
      window.removeEventListener('offline', onNetworkChange);
    };
  }, []);

  const status = checking ? { text: 'Checking…', colour: 'bg-zinc-400 animate-pulse' }
    : check ? labels[check.state] : { text: 'Not checked yet', colour: 'bg-zinc-500' };
  return <div className="p-6 lg:p-10 space-y-8 max-w-5xl mx-auto">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-2xl font-bold text-white tracking-tight">Server Status</h2>
        <p className="text-xs text-zinc-500 mt-2">Live database checks from this browser. Requests time out after 10 seconds.</p></div>
      <button type="button" className="button-secondary" disabled={checking} onClick={() => checkNow.current()}>
        <RefreshCw size={14} className={checking ? 'animate-spin' : ''} />{checking ? 'Checking…' : 'Check now'}
      </button>
    </header>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <section className="bg-[#111114] border border-surface-container-highest rounded-md p-6" aria-label="Database connectivity">
        <h3 className="text-sm font-bold text-zinc-400 mb-4 uppercase tracking-widest">Database connectivity</h3>
        <p className="flex items-center gap-3 mb-5" role="status" aria-live="polite">
          <span className={`w-3 h-3 rounded-full shrink-0 ${status.colour}`} aria-hidden="true" />
          <span className="font-mono text-white">{status.text}</span>
        </p>
        <dl className="space-y-3 text-xs">
          <StatusRow label="Latest request duration" value={check?.responseMs == null ? '—' : `${check.responseMs} ms`} />
          <StatusRow label="Last check" value={time(check?.checkedAt ?? null)} />
          <StatusRow label="Last successful check" value={time(lastSuccess)} />
          <StatusRow label="HTTP status" value={check?.httpStatus == null ? '—' : String(check.httpStatus)} />
          <StatusRow label="Successful measured requests" value={`${requests.successful} / ${requests.total} this visit`} />
          <StatusRow label="Provider" value="Supabase" />
        </dl>
        {!checking && check?.message && <p className="text-xs text-amber-300/80 leading-6 mt-4 break-words">{check.message}</p>}
        <p className="text-[11px] text-zinc-500 leading-6 mt-5">Duration includes your network and session handling. Checks repeat after 15 seconds and pause when this tab is hidden. This does not measure service-wide uptime.</p>
        <a href="https://status.supabase.com/" target="_blank" rel="noopener noreferrer" className="inline-block text-xs text-toxic-purple hover:underline mt-3">Supabase service status ↗</a>
      </section>
      <section className="bg-[#111114] border border-surface-container-highest rounded-md p-6" aria-label="Database counts">
        <h3 className="text-sm font-bold text-zinc-400 mb-5 uppercase tracking-widest">Database counts</h3>
        <dl className="space-y-4 text-xs">
          <CountRow label="Accessible players" count={counts.players} />
          <CountRow label="Accessible banned accounts" count={counts.banned} />
          <CountRow label="Accessible audit events" count={counts.logs} />
          <StatusRow label="Last count check" value={time(countsAt)} />
        </dl>
        <p className="text-[11px] text-zinc-500 leading-6 mt-5">Counts follow your account's database permissions. They refresh about once a minute after a successful check, or when you choose Check now. Unavailable counts are shown as a dash.</p>
      </section>
    </div>
  </div>;
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-wrap justify-between gap-x-4 gap-y-1"><dt className="text-zinc-500">{label}</dt><dd className="text-zinc-300 font-mono">{value}</dd></div>;
}
function CountRow({ label, count }: { label: string; count: CountState }) {
  return <div><StatusRow label={label} value={count.value === null ? '—' : count.value.toLocaleString('en-US')} />
    {count.error && <p className="text-[11px] text-amber-300/80 mt-1 break-words">{count.error}</p>}</div>;
}
