// Billing is on only when STRIPE_SECRET_KEY is set. Without it every workspace has all features (local and self-hosted use).
import 'server-only';
import { HttpError } from '@/lib/http';
import type { Ctx } from '@/lib/context';

export const billingOn = () => !!process.env.STRIPE_SECRET_KEY;

export function requirePro(ctx: Ctx) {
  if (ctx.ws.plan !== 'pro') throw new HttpError(402, 'Connected sources and server runs are part of the Pro plan. Use Upgrade to Pro at the top of the page.', 'upgrade_required');
}

// POST with params, GET without.
export async function stripe(path: string, params?: Record<string, string>): Promise<any> {
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    method: params ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY, 'content-type': 'application/x-www-form-urlencoded' },
    body: params && new URLSearchParams(params),
  });
  const j: any = await r.json().catch(() => null);
  if (!r.ok) { console.error('[stripe]', path, r.status, j?.error?.message); throw new HttpError(502, 'The payment service refused the request. Try again shortly.'); }
  return j;
}
