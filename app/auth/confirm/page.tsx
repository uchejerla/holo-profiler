// Email links (sign-in and invite) land here. Opening the page does NOT use the one-time token: mail scanners and
// link previews open every link in an email, which used to burn the token before the person clicked. Only the button does.
// Email templates: {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/app   (type=invite for Invite user)
import { safeNext } from '@/lib/safe-next';

export const metadata = { title: 'Sign in · Holo Profiler' };

export default async function Confirm({ searchParams }: { searchParams: Promise<{ token_hash?: string; type?: string; next?: string }> }) {
  const sp = await searchParams;
  return (
    <main className="auth">
      <div className="card">
        <div className="brand"><div><h1>Holo Profiler</h1><p>One more step to sign in</p></div></div>
        <form method="post" action="/auth/verify" className="form">
          <input type="hidden" name="token_hash" value={sp.token_hash ?? ''} />
          <input type="hidden" name="type" value={sp.type ?? ''} />
          <input type="hidden" name="next" value={safeNext(sp.next)} />
          <button className="btn" type="submit">Continue to Holo Profiler</button>
        </form>
      </div>
    </main>
  );
}
