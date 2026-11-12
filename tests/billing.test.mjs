// Billing: Stripe webhook signature check and the event -> plan mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { verifySignature, planChange } = require('../lib/core/billing.js');

test('webhook signature: accepts a fresh signed payload, rejects tampering, wrong secret and replays', () => {
  const secret = 'whsec_test', body = '{"id":"evt_1"}', now = 1_800_000_000_000, t = now / 1000;
  const sig = (s, ts, b) => `t=${ts},v1=${createHmac('sha256', s).update(ts + '.' + b).digest('hex')}`;
  assert.equal(verifySignature(body, sig(secret, t, body), secret, now), true);
  assert.equal(verifySignature(body, 'v0=x,' + sig(secret, t, body) + ',v1=bad', secret, now), true, 'extra schemes are ignored');
  assert.equal(verifySignature(body + ' ', sig(secret, t, body), secret, now), false);
  assert.equal(verifySignature(body, sig('other', t, body), secret, now), false);
  assert.equal(verifySignature(body, sig(secret, t - 3600, body), secret, now), false, 'an hour old');
  for (const h of [null, '', 't=', 'v1=abc', `t=${t}`]) assert.equal(verifySignature(body, h, secret, now), false);
  assert.equal(verifySignature(body, sig('', t, body), '', now), false, 'no secret configured');
});

test('plan changes: checkout and active subscriptions are pro, ended ones are free, other events are ignored', () => {
  const sub = (type, status) => ({ type, data: { object: { customer: 'cus_1', status, metadata: { workspace_id: 'ws1' } } } });
  assert.deepEqual(planChange({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: 'ws1', customer: 'cus_1' } } }), { ws: 'ws1', customer: 'cus_1', plan: 'pro' });
  assert.equal(planChange({ type: 'checkout.session.completed', data: { object: { mode: 'payment', client_reference_id: 'ws1' } } }), null);
  assert.equal(planChange(sub('customer.subscription.updated', 'active')).plan, 'pro');
  assert.equal(planChange(sub('customer.subscription.updated', 'past_due')).plan, 'pro');
  assert.equal(planChange(sub('customer.subscription.updated', 'unpaid')).plan, 'free');
  assert.equal(planChange(sub('customer.subscription.updated', 'canceled')).plan, 'free');
  assert.equal(planChange(sub('customer.subscription.deleted', 'active')).plan, 'free');
  assert.equal(planChange({ type: 'customer.subscription.updated', data: { object: { status: 'active', metadata: {} } } }), null, 'not one of ours');
  assert.equal(planChange({ type: 'invoice.paid', data: { object: {} } }), null);
  assert.equal(planChange({}), null);
});
