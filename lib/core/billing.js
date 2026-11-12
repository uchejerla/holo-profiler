/* Stripe billing, without the Stripe SDK: webhook signature check and "which workspace is on which plan now". */
'use strict';
const { createHmac, timingSafeEqual } = require('crypto');

// Stripe-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "t.payload">. Rejects old timestamps so a captured request cannot be replayed.
function verifySignature(payload, header, secret, nowMs) {
  const parts = String(header || '').split(',').map(p => p.split('='));
  const t = (parts.find(p => p[0] === 't') || [])[1];
  if (!t || !secret || Math.abs((nowMs || Date.now()) / 1000 - Number(t)) > 300) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(t + '.' + payload).digest('hex'));
  return parts.some(p => { const got = Buffer.from(p[1] || ''); return p[0] === 'v1' && got.length === want.length && timingSafeEqual(got, want); });
}

// A Stripe event -> { ws, customer, plan } or null when it does not change a plan.
// Both the checkout session and the subscription carry the workspace id (set when the checkout is created), so event order does not matter.
function planChange(event) {
  const o = event && event.data && event.data.object;
  if (!o) return null;
  if (event.type === 'checkout.session.completed' && o.mode === 'subscription' && o.client_reference_id)
    return { ws: o.client_reference_id, customer: o.customer || null, plan: 'pro' };
  if (/^customer\.subscription\.(created|updated|deleted)$/.test(event.type) && o.metadata && o.metadata.workspace_id)
    // past_due stays pro while Stripe retries the card; it becomes canceled or unpaid if that fails.
    return { ws: o.metadata.workspace_id, customer: o.customer || null, plan: ['active', 'trialing', 'past_due'].includes(o.status) && event.type !== 'customer.subscription.deleted' ? 'pro' : 'free' };
  return null;
}

module.exports = { verifySignature, planChange };
