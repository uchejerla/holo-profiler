import LoginForm from './login-form';
import { safeNext } from '@/lib/safe-next';

export const metadata = { title: 'Sign in · Holo Profiler' };

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <main className="auth">
      <div className="card">
        <div className="brand">
          <svg width="38" height="38" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" fill="none" stroke="#5fe1ff" strokeWidth="1.5" strokeDasharray="3 3" /><circle cx="20" cy="20" r="11" fill="none" stroke="#5fe1ff" strokeWidth="2" /><circle cx="20" cy="20" r="3" fill="#5fe1ff" /></svg>
          <div><h1>Holo Profiler</h1><p>Data quality scan for any flat file</p></div>
        </div>
        {sp.error === 'link' && <p className="err" role="alert">That sign-in link has expired or was already used. Ask for a new one.</p>}
        <LoginForm next={safeNext(sp.next)} />
        <p className="fine">Files you drop in are profiled in your browser and never uploaded. Your rules, schedules, run history and exceptions are saved to your workspace.</p>
      </div>
    </main>
  );
}
