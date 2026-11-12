// GET /upgrade?interval=month|year: sends the browser to Stripe. Free workspaces get Checkout, paying ones the billing portal.
// A plain link target (no page script needed), so the pricing page and the app's Upgrade / Billing button both point here.
import { NextResponse, type NextRequest } from 'next/server';
import { getCtx, requireAdmin } from '@/lib/context';
import { billingOn, stripe } from '@/lib/billing';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin, back = origin + '/app';
  const yearly = req.nextUrl.searchParams.get('interval') === 'year';
  try {
    const price = (yearly && process.env.STRIPE_PRICE_ID_YEARLY) || process.env.STRIPE_PRICE_ID;
    if (!billingOn() || !price) return NextResponse.redirect(back);
    const ctx = await getCtx();
    requireAdmin(ctx);
    const { data: w, error } = await ctx.sb.from('workspaces').select('plan, stripe_customer_id').eq('id', ctx.ws.id).single();
    if (error) throw new Error(error.message);
    if (w.plan === 'pro' && w.stripe_customer_id)
      return NextResponse.redirect((await stripe('billing_portal/sessions', { customer: w.stripe_customer_id, return_url: back })).url, 303);
    const s = await stripe('checkout/sessions', {
      mode: 'subscription',
      'line_items[0][price]': price,
      'line_items[0][quantity]': '1',
      client_reference_id: ctx.ws.id,
      'subscription_data[metadata][workspace_id]': ctx.ws.id,
      allow_promotion_codes: 'true',
      // Shown above the Pay button: evidence the buyer saw the policy if a charge is ever disputed.
      'custom_text[submit][message]': `By subscribing you agree to the [refund policy](${origin}/refund-policy).`,
      success_url: back + '?upgraded=1',
      cancel_url: origin + '/#pricing',
      ...(w.stripe_customer_id ? { customer: w.stripe_customer_id } : ctx.user.email ? { customer_email: ctx.user.email } : {}),
    });
    return NextResponse.redirect(s.url, 303);
  } catch (e: any) {
    if (e?.status === 401) return NextResponse.redirect(new URL('/login?next=' + encodeURIComponent('/upgrade' + req.nextUrl.search), origin));
    const msg = e?.status === 403 ? 'Only workspace owners and admins can change the plan.' : 'Could not open billing. Go back and try again.';
    if (e?.status !== 403) console.error('[upgrade]', e);
    return new NextResponse(msg, { status: e?.status === 403 ? 403 : 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}
