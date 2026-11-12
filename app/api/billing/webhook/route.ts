// POST /api/billing/webhook: Stripe tells us when a subscription starts, changes or ends. Authenticated by Stripe's signature, not a session.
import type { NextRequest } from 'next/server';
import { handle, HttpError, json } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase/admin';
import billingMod from '@/lib/core/billing.js';

export const dynamic = 'force-dynamic';
const { verifySignature, planChange } = billingMod as any;

export const POST = handle(async (req: NextRequest) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, 'STRIPE_WEBHOOK_SECRET is not set on the server');
  const payload = await req.text();
  if (!verifySignature(payload, req.headers.get('stripe-signature'), secret)) throw new HttpError(400, 'Bad signature');
  const c = planChange(JSON.parse(payload));
  if (c) {
    const { error } = await supabaseAdmin().from('workspaces')
      .update({ plan: c.plan, ...(c.customer ? { stripe_customer_id: c.customer } : {}) }).eq('id', c.ws);
    // A 500 makes Stripe retry, so a database blip does not lose a payment.
    if (error) throw new HttpError(500, error.message);
  }
  return json({ received: true });
});
