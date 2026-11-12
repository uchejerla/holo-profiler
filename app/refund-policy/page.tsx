// Refund policy. Linked from the pricing page and shown above the Pay button in Stripe Checkout (see app/upgrade/route.ts).
import Link from 'next/link';

export const metadata = { title: 'Refund policy · Holo Profiler' };

export default function RefundPolicy() {
  const email = process.env.NEXT_PUBLIC_SUPPORT_EMAIL;
  const contact = email ? <a href={`mailto:${email}`}>{email}</a> : <>replying to your payment receipt</>;
  return (
    <div className="land">
      <header className="lnav"><Link className="lname" href="/">Holo Profiler</Link><nav><Link href="/#pricing">Pricing</Link></nav></header>
      <main className="prose">
        <h1>Refund policy</h1>
        <p className="fine">Last updated: November 11, 2026</p>

        <h2>Try it before you pay</h2>
        <p>The Free plan has no time limit and needs no card. Please use it to check that Holo Profiler fits your data before you subscribe to Pro.</p>

        <h2>Monthly subscriptions</h2>
        <p>Monthly payments are not refundable. You can cancel at any time from <b>Billing</b> in the app. Cancelling stops the next renewal, and Pro stays on until the end of the month you have already paid for. We do not refund or credit part of a month.</p>

        <h2>Yearly subscriptions</h2>
        <p>If you ask within <b>7 days of your first yearly payment</b>, we refund that payment in full and your workspace returns to the Free plan. After 7 days, and for every yearly renewal, payments are not refundable. If you cancel, Pro stays on until the end of the year you have already paid for. We do not refund or credit part of a year.</p>

        <h2>Renewals</h2>
        <p>Subscriptions renew automatically at the price shown when you subscribed, until you cancel. To avoid being charged for the next period, cancel before the renewal date shown under <b>Billing</b>. Forgetting to cancel, or not using the service, is not a reason for a refund.</p>

        <h2>When we always refund</h2>
        <ul>
          <li>You were charged twice for the same period, or charged after a cancellation that we confirmed.</li>
          <li>We were unable to provide the Pro features for most of a billing period because of a fault on our side. We refund that period, or the unused part of it, at our choice.</li>
        </ul>

        <h2>When we do not refund</h2>
        <ul>
          <li>Your account was suspended or closed for misuse of the service.</li>
          <li>The problem is with a system we do not run, such as your Snowflake account, your S3 bucket or their credentials.</li>
          <li>You changed your mind after the periods described above.</li>
        </ul>

        <h2>How to ask</h2>
        <p>Contact us by {contact}, from the email address on the account, with the name of your workspace. Approved refunds go back to the original payment method, usually within 5 to 10 business days. Please contact us before disputing a charge with your bank: we can usually fix a billing mistake faster, and accounts with an open dispute are paused until it is settled.</p>

        <h2>Your legal rights</h2>
        <p>Nothing in this policy limits any right to a refund that the law of your country gives you and that cannot be waived by agreement.</p>
      </main>
      <footer className="lfoot"><span>© {new Date().getFullYear()} Holo Profiler</span><Link href="/">Home</Link></footer>
    </div>
  );
}
