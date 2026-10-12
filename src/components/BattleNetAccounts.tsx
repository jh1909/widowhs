import { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, X } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import VerifiedBadge from "./VerifiedBadge";

type Account = { name: string; battletag: string | null; verified: boolean };
const verifierKey = "widowhs.battlenet.verifier";
const outcomes: Record<string, string> = {
  success: "Battle.net account connected and verified. Your matches are now linked to your profile.",
  cancelled: "Battle.net linking was cancelled. Your accounts have not changed.",
  claimed: "This account or player name is already claimed. It cannot be linked to your profile.",
  limit: "This account could not be linked. You can connect up to two Battle.net accounts.",
  failed: "Battle.net linking failed. Please try again from your profile.",
};

export default function BattleNetAccounts({ playerName, accounts, isOwner, onChanged }: {
  playerName: string; accounts: string[]; isOwner: boolean; onChanged: () => void;
}) {
  const [labels, setLabels] = useState<Account[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();
  const result = searchParams.get("bnet");
  const ticket = searchParams.get("ticket");
  const finish = useRef<{ ticket: string; promise: Promise<string> } | null>(null);
  const accountKey = JSON.stringify(accounts);

  useEffect(() => {
    let active = true;
    setLabels(accounts.map(name => ({ name, battletag: null, verified: false })));
    supabase.rpc("get_player_bnet_accounts", { p_player_name: playerName }).then(({ data, error }) => {
      if (!active) return;
      if (error) setError("Could not load Battle.net verification. Please reload your profile.");
      else setLabels(data ?? []);
    });
    return () => { active = false; };
  }, [playerName, accountKey, reload]);

  useEffect(() => {
    if (isOwner && result && outcomes[result]) {
      try { sessionStorage.removeItem(verifierKey); } catch { /* Storage may be disabled. */ }
    }
  }, [isOwner, result]);

  useEffect(() => {
    if (!isOwner || result !== "confirm" || !ticket) return;
    let active = true;
    setBusy("connect");
    if (finish.current?.ticket !== ticket) {
      const promise = (async () => {
        const verifier = sessionStorage.getItem(verifierKey);
        if (!verifier) return "failed";
        try {
          const { data, error } = await supabase.functions.invoke("battlenet-oauth", {
            body: { action: "complete", ticket, verifier },
          });
          if (error) {
            const body = await error.context?.json?.().catch(() => null);
            return ["claimed", "limit"].includes(body?.error) ? body.error : "failed";
          }
          return data?.result === "success" ? "success" : "failed";
        } catch { return "failed"; }
        finally {
          if (sessionStorage.getItem(verifierKey) === verifier) sessionStorage.removeItem(verifierKey);
        }
      })().catch(() => "failed");
      finish.current = { ticket, promise };
    }
    // Reuse the pending promise during StrictMode's effect replay.
    finish.current.promise.then(outcome => {
      if (!active) return;
      const next = new URLSearchParams(searchParams);
      next.set("bnet", outcome); next.delete("ticket");
      setSearchParams(next, { replace: true });
      setBusy(null);
      if (outcome === "success") { setReload(value => value + 1); onChanged(); }
    });
    return () => { active = false; };
  }, [isOwner, result, ticket, setSearchParams]);

  const connect = async () => {
    setBusy("connect"); setError(null);
    try {
      const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map(byte => byte.toString(16).padStart(2, "0")).join("");
      sessionStorage.setItem(verifierKey, verifier);
      const { data, error } = await supabase.functions.invoke("battlenet-oauth", {
        body: { redirectUrl: `${window.location.origin}${window.location.pathname}`, verifier },
      });
      if (error) {
        // Edge Function errors carry their JSON response in context.
        const body = await error.context?.json?.().catch(() => null);
        throw new Error(body?.error ?? "Could not start Battle.net linking. Please try again.");
      }
      const url = new URL(data?.url);
      if (url.origin !== "https://oauth.battle.net" || url.pathname !== "/authorize") {
        throw new Error("Battle.net returned an invalid login address.");
      }
      window.location.assign(url.href);
    } catch (error) {
      try { sessionStorage.removeItem(verifierKey); } catch { /* Storage may be disabled. */ }
      setError(error instanceof Error ? error.message : "Could not start Battle.net linking.");
      setBusy(null);
    }
  };
  const remove = async (account: string) => {
    if (!window.confirm(`Disconnect '${account}'? Match history stays on your profile. This account will no longer be verified.`)) return;
    setBusy(account); setError(null);
    try {
      const { error } = await supabase.rpc("link_bnet_account", {
        p_player_name: playerName, p_account: account, p_remove: true,
      });
      if (error) throw error;
      setReload(value => value + 1);
      onChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : (error as { message?: string }).message ?? "Could not disconnect this account.");
    } finally { setBusy(null); }
  };

  return (
    <section className="flex flex-col gap-3 mt-4">
      <h3 className="font-sans text-[24px] font-semibold text-on-surface uppercase tracking-tight">Battle.net Accounts</h3>
      <div className="panel p-6 flex flex-col gap-4">
        <p className="text-zinc-400 text-sm leading-relaxed">
          Connect up to two accounts through Battle.net to verify ownership and add their matches to your profile.
          Workshop logs use player names. A name already claimed by another profile cannot be linked.
        </p>
        {isOwner && result && outcomes[result] && (
          <div role="status" className={`rounded-lg border p-3 text-sm flex items-start justify-between gap-3 ${result === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-amber-500/30 bg-amber-500/10 text-amber-200"}`}>
            <span>{outcomes[result]}</span>
            <button aria-label="Dismiss Battle.net status" onClick={() => {
              const next = new URLSearchParams(searchParams); next.delete("bnet"); setSearchParams(next, { replace: true });
            }}><X size={16} /></button>
          </div>
        )}
        {labels.map(account => (
          <div key={account.name} className="flex justify-between items-center gap-3 bg-surface-container/50 p-3 rounded-lg border border-toxic-purple/20">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
              <span className="font-sans font-bold text-white text-lg break-all">{account.battletag ?? account.name}</span>
              {account.verified ? <VerifiedBadge verified /> : <span className="text-xs text-zinc-500">Not verified</span>}
            </div>
            {isOwner && <button onClick={() => remove(account.name)} disabled={busy !== null}
              className="p-2 text-red-400 hover:text-red-300 disabled:opacity-50" aria-label={`Disconnect ${account.name}`}>
              {busy === account.name ? <LoaderCircle size={18} className="animate-spin" /> : <X size={18} />}
            </button>}
          </div>
        ))}
        {isOwner && (
          <div className="flex flex-col items-start gap-3">
            {accounts.length > 0 && labels.some(account => !account.verified) && <p className="text-sm text-zinc-400">
              Previously added accounts keep their matches. Connect each one through Battle.net to verify it.
            </p>}
            <button onClick={connect} disabled={busy !== null}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-sky-400/30 bg-sky-400/10 px-5 py-3 font-semibold text-sky-100 hover:bg-sky-400/20 disabled:opacity-50">
              {busy === "connect" ? <LoaderCircle size={17} className="animate-spin" /> : <ExternalLink size={17} />}
              {busy === "connect" ? "Connecting…" : "Connect Battle.net"}
            </button>
            <p className="text-xs text-zinc-500">You will sign in on Blizzard's website. Your Discord login and match history stay on this profile.</p>
          </div>
        )}
        {!isOwner && accounts.length === 0 && <p className="text-sm text-zinc-500">No Battle.net accounts connected.</p>}
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      </div>
    </section>
  );
}
