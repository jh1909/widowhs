import { useEffect, useId, useState } from 'react';
import { Edit2, LoaderCircle, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { BIO_LIMIT, emptyProfileDetails, setupFields, type ProfileDetails as Details } from '../lib/profile-details';

export default function ProfileDetails({ playerName, isOwner, isAdmin = false }: { playerName: string; isOwner: boolean; isAdmin?: boolean }) {
  const formId = useId();
  const canEdit = isOwner || isAdmin;
  const moderating = isAdmin && !isOwner;
  const [details, setDetails] = useState<Details>(emptyProfileDetails);
  const [draft, setDraft] = useState<Details>(emptyProfileDetails);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [saved, setSaved] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setEditing(false);
    setSaved(false);
    setConfirmClear(false);
    setError(null);
    setDetails(emptyProfileDetails());
    supabase.rpc('get_player_profile_details', { p_player_name: playerName }).then(({ data, error }) => {
      if (!active) return;
      if (error) setError('Could not load bio and setup. Please try again.');
      else setDetails(data ?? emptyProfileDetails());
      setLoading(false);
    });
    return () => { active = false; };
  }, [playerName, isOwner, isAdmin, reload]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    await persist(draft);
  }

  async function persist(value: Details) {
    if (saving || !canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const { data, error } = await supabase.rpc('update_player_profile_details', {
        p_player_name: playerName, p_bio: value.bio, p_setup: value.setup,
      });
      if (error) throw error;
      setDetails(data);
      setEditing(false);
      setConfirmClear(false);
      setSaved(true);
    } catch {
      setError('Your changes could not be saved. Please try again.');
    } finally { setSaving(false); }
  }

  const visibleFields = setupFields.filter(field => details.setup[field.key]);
  const hasContent = !!details.bio || visibleFields.length > 0;
  if (!loading && !error && !editing && !canEdit && !hasContent) return null;

  const controlClass = 'w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-toxic-purple/60 disabled:opacity-60';
  return (
    <section className="panel p-5 sm:p-7" aria-label="Player bio and setup" aria-busy={loading || saving}>
      <div className="flex items-center justify-between gap-3 mb-5">
        <h2 className="text-base font-semibold text-zinc-100">Bio &amp; Setup</h2>
        {canEdit && !loading && !editing && !error && (
          <button type="button" className="button-secondary" onClick={() => { setDraft({ ...details, setup: { ...details.setup } }); setEditing(true); setSaved(false); }}>
            <Edit2 size={14} /> Edit profile
          </button>
        )}
      </div>
      {loading ? <p className="text-sm text-zinc-500" role="status">Loading bio and setup…</p> : editing && canEdit ? (
        <form onSubmit={save} className="space-y-5">
          {moderating && <p className="text-xs text-amber-200/80">You are editing {playerName}’s bio and setup as an admin.</p>}
          <p className="text-xs text-zinc-500">All fields are optional and visible to everyone. Clear a field to remove it from the profile.</p>
          <div>
            <label htmlFor={`${formId}-bio`} className="block text-sm text-zinc-300 mb-2">Bio</label>
            <textarea id={`${formId}-bio`} className={controlClass} rows={3} maxLength={BIO_LIMIT} disabled={saving}
              placeholder="A few words about you" value={draft.bio} onChange={event => setDraft({ ...draft, bio: event.target.value })} />
            <p className="text-xs text-zinc-500 text-right mt-1">{draft.bio.length}/{BIO_LIMIT}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {setupFields.map(field => (
              <div key={field.key} className={'multiline' in field ? 'sm:col-span-2' : ''}>
                <label htmlFor={`${formId}-${field.key}`} className="block text-sm text-zinc-300 mb-2">{field.label}</label>
                {'multiline' in field ? (
                  <textarea id={`${formId}-${field.key}`} className={controlClass} rows={3} maxLength={field.limit} disabled={saving}
                    placeholder={field.placeholder} value={draft.setup[field.key] ?? ''} onChange={event => setDraft({ ...draft, setup: { ...draft.setup, [field.key]: event.target.value } })} />
                ) : (
                  <input id={`${formId}-${field.key}`} type="text" className={controlClass} maxLength={field.limit} disabled={saving}
                    placeholder={field.placeholder} value={draft.setup[field.key] ?? ''} onChange={event => setDraft({ ...draft, setup: { ...draft.setup, [field.key]: event.target.value } })} />
                )}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="submit" className="button-primary" disabled={saving}>{saving && <LoaderCircle size={14} className="animate-spin" />}{saving ? 'Saving…' : 'Save changes'}</button>
            <button type="button" className="button-secondary" disabled={saving} onClick={() => { setEditing(false); setConfirmClear(false); setError(null); }}>Cancel</button>
            {isAdmin && hasContent && !confirmClear && <button type="button" className="button-secondary text-red-300!" disabled={saving} onClick={() => { setConfirmClear(true); setError(null); }}>
              <Trash2 size={14} /> Clear bio &amp; setup
            </button>}
          </div>
          {confirmClear && <div role="group" aria-label="Confirm clearing bio and setup" className="rounded-lg border border-red-400/20 bg-red-400/5 p-4 space-y-3">
            <p className="text-sm text-zinc-300">Remove all bio and setup details from {playerName}’s profile?</p>
            <div className="flex flex-wrap gap-3">
              <button type="button" className="button-secondary text-red-300!" disabled={saving} onClick={() => persist(emptyProfileDetails())}>Confirm clear</button>
              <button type="button" className="button-secondary" disabled={saving} onClick={() => setConfirmClear(false)}>Keep details</button>
            </div>
          </div>}
        </form>
      ) : (
        <div className="space-y-6">
          {details.bio && <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap break-words">{details.bio}</p>}
          {!!visibleFields.length && <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-5">
            {visibleFields.map(field => <div key={field.key} className={'multiline' in field ? 'sm:col-span-2 lg:col-span-3' : ''}>
              <dt className="text-xs text-zinc-500 mb-1.5">{field.label}</dt>
              <dd className="text-sm text-zinc-200 whitespace-pre-wrap break-words">{details.setup[field.key]}</dd>
            </div>)}
          </dl>}
          {!error && !hasContent && <p className="text-sm text-zinc-500">{moderating ? 'This player has not added a bio or setup yet.' : 'Add a short bio or share your gear and settings.'}</p>}
        </div>
      )}
      {error && <div className="mt-4 flex flex-wrap items-center gap-3">
        <p role="alert" className="text-sm text-red-400">{error}</p>
        {!editing && <button type="button" className="button-secondary" onClick={() => setReload(value => value + 1)}>Retry</button>}
      </div>}
      {saved && <p role="status" className="text-xs text-emerald-400 mt-4">Profile updated.</p>}
    </section>
  );
}
