// POST /api/billing: where to send the browser next. Free workspaces get a Stripe Checkout page, paying ones the Stripe billing portal.
import type { NextRequest } from 'next/server';
import { getCtx, requireAdmin } from '@/lib/context';
import { checkSameOrigin, handle, HttpError, json } from '@/lib/http';
import { billingOn, stripe } from '@/lib/billing';

export const dynamic = 'force-dynamic';

export const POST = handle(async (req: NextRequest) => {
  checkSameOrigin(req);
  if (!billingOn() || !process.env.STRIPE_PRICE_ID) throw new HttpError(404, 'Billing is not set up on this server');
  const ctx = await getCtx();
  requireAdmin(ctx);
  const { data: w, error } = await ctx.sb.from('workspaces').select('plan, stripe_customer_id').eq('id', ctx.ws.id).single();
  if (error) throw new HttpError(500, error.message, 'unavailable');
  const back = req.nextUrl.origin + '/app';
  if (w.plan === 'pro' && w.stripe_customer_id)
    return json({ url: (await stripe('billing_portal/sessions', { customer: w.stripe_customer_id, return_url: back })).url });
  const s = await stripe('checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': process.env.STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    client_reference_id: ctx.ws.id,
    'subscription_data[metadata][workspace_id]': ctx.ws.id,
    allow_promotion_codes: 'true',
    success_url: back + '?upgraded=1',
    cancel_url: back,
    ...(w.stripe_customer_id ? { customer: w.stripe_customer_id } : ctx.user.email ? { customer_email: ctx.user.email } : {}),
  });
  return json({ url: s.url });
});
