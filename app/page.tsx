// Public landing page with pricing. Prices are read from Stripe so the page always shows what Checkout will charge.
import Link from 'next/link';
import { billingOn, stripe } from '@/lib/billing';

export const revalidate = 3600;
export const metadata = { title: 'Holo Profiler · Data quality for any flat file', description: 'Drop a CSV, Excel or Parquet file and see its data quality in seconds. Rules written for you, scheduled runs on Snowflake and S3, and exception tracking.' };

type Price = { amount: number; currency: string } | null;
async function price(id?: string): Promise<Price> {
  if (!billingOn() || !id) return null;
  try { const p = await stripe('prices/' + id); return typeof p.unit_amount === 'number' ? { amount: p.unit_amount / 100, currency: p.currency } : null; }
  catch { return null; }
}
const money = (p: NonNullable<Price>) => new Intl.NumberFormat('en-US', { style: 'currency', currency: p.currency, maximumFractionDigits: p.amount % 1 ? 2 : 0 }).format(p.amount);

const FEATURES: [string, string][] = [
  ['A score you can defend', 'Completeness, validity, uniqueness and consistency rolled into one file score, with the reasons behind it.'],
  ['Rules written for you', 'Suggested from what the data actually looks like. Accept, edit or reject each one, then export as Snowflake SQL.'],
  ['Your file stays with you', 'Profiling runs entirely in your browser. Files you drop are never uploaded.'],
  ['Keeps watching', 'Run the same rules hourly, daily or weekly against a Snowflake table or an S3 folder, even with the page closed.'],
  ['Exceptions, not noise', 'Each failing rule becomes one exception with an owner, notes and an audit trail. It reopens by itself if the rule fails again.'],
  ['Built for teams', 'A workspace per team with owner, admin, member and viewer roles enforced in the database.'],
];
const FREE = ['Profile CSV, Excel and Parquet files in your browser', 'Suggested and custom rules', 'Snowflake SQL and JSON export', 'Run history and exceptions for files you drop'];
const PRO = ['Everything in Free', 'Connect Snowflake and S3 sources', 'Scheduled runs: hourly, daily or weekly', 'Run on the server on demand'];

export default async function Home() {
  const [monthly, yearly] = await Promise.all([price(process.env.STRIPE_PRICE_ID), price(process.env.STRIPE_PRICE_ID_YEARLY)]);
  const save = monthly && yearly && monthly.currency === yearly.currency ? Math.round((1 - yearly.amount / (monthly.amount * 12)) * 100) : 0;
  return (
    <div className="land">
      <header className="lnav">
        <span className="lname">Holo Profiler</span>
        <nav><a href="#features">Features</a><a href="#pricing">Pricing</a><Link className="btn" href="/app">Open app</Link></nav>
      </header>
      <main>
        <section className="hero">
          <h1>Drop a file. See its data quality in seconds.</h1>
          <p>Holo Profiler profiles your data in the browser, suggests the rules it should pass, and keeps watching it on a schedule.</p>
          <Link className="btn big" href="/app">Start free</Link>
          <p className="fine">No card needed. Sign in with your work email.</p>
        </section>

        <section id="features" aria-labelledby="fh">
          <h2 id="fh">What you get</h2>
          <div className="grid3">{FEATURES.map(([t, d]) => <div className="card" key={t}><h3>{t}</h3><p>{d}</p></div>)}</div>
        </section>

        <section id="pricing" aria-labelledby="ph">
          <h2 id="ph">Pricing</h2>
          <div className="grid3">
            <div className="card plan">
              <h3>Free</h3>
              <p className="amt">{money({ amount: 0, currency: monthly?.currency || 'usd' })}</p>
              <ul>{FREE.map(f => <li key={f}>{f}</li>)}</ul>
              <Link className="btn" href="/app">Start free</Link>
            </div>
            {monthly ? <>
              <div className="card plan">
                <h3>Pro · monthly</h3>
                <p className="amt">{money(monthly)}<small> per workspace / month</small></p>
                <ul>{PRO.map(f => <li key={f}>{f}</li>)}</ul>
                <a className="btn" href="/upgrade?interval=month">Get Pro monthly</a>
              </div>
              {yearly && <div className="card plan best">
                <h3>Pro · yearly{save > 0 && <span className="tag">Save {save}%</span>}</h3>
                <p className="amt">{money(yearly)}<small> per workspace / year</small></p>
                <ul>{PRO.map(f => <li key={f}>{f}</li>)}</ul>
                <a className="btn" href="/upgrade?interval=year">Get Pro yearly</a>
              </div>}
            </> : <div className="card plan">
              <h3>Pro</h3>
              <p className="amt">Included<small> during early access</small></p>
              <ul>{PRO.map(f => <li key={f}>{f}</li>)}</ul>
              <Link className="btn" href="/app">Open app</Link>
            </div>}
          </div>
          <p className="fine">Cancel any time; Pro stays on until the end of the period you paid for. See the <Link href="/refund-policy">refund policy</Link>.</p>
        </section>
      </main>
      <footer className="lfoot"><span>© {new Date().getFullYear()} Holo Profiler</span><Link href="/refund-policy">Refund policy</Link><Link href="/login">Sign in</Link></footer>
    </div>
  );
}
