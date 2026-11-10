'use client';
import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';

export default function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setState('sending');
    const redirect = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const { error } = await supabaseBrowser().auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: redirect } });
    if (error) { setErr(error.message); setState('idle'); return; }
    setState('sent');
  }

  if (state === 'sent') return <p className="ok" role="status">Check <b>{email}</b> for a sign-in link. You can close this tab.</p>;
  return (
    <form onSubmit={submit} className="form">
      <label className="f"><span className="lbl">Work email</span>
        <input className="inp" type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" />
      </label>
      {err && <p className="err" role="alert">{err}</p>}
      <button className="btn" type="submit" disabled={state === 'sending'}>{state === 'sending' ? 'Sending…' : 'Email me a sign-in link'}</button>
    </form>
  );
}
