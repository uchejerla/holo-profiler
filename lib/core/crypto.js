/* Secrets at rest: AES-256-GCM with a 32-byte key from APP_ENCRYPTION_KEY (base64). Ciphertext format: v1.<iv>.<tag>.<data>, base64url parts. */
'use strict';
const crypto = require('node:crypto');

function keyFrom(b64) {
  const k = Buffer.from(String(b64 || ''), 'base64');
  if (k.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64 encoded (npm run gen:key)');
  return k;
}
function encrypt(obj, keyB64, aad) {
  const key = keyFrom(keyB64), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(String(aad)));
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
function decrypt(text, keyB64, aad) {
  const [v, iv, tag, data] = String(text || '').split('.');
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unreadable secret');
  const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(keyB64), Buffer.from(iv, 'base64url'));
  if (aad) d.setAAD(Buffer.from(String(aad)));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8'));
}
module.exports = { encrypt, decrypt };
