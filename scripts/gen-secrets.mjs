// Prints fresh values for the two secrets the app needs. Paste them into Vercel's environment variables
// (and .env.local for local work). Nothing is saved anywhere by this script.
import { randomBytes } from 'node:crypto';
console.log('APP_ENCRYPTION_KEY=' + randomBytes(32).toString('base64'));
console.log('CRON_SECRET=' + randomBytes(32).toString('base64url'));
console.log('\nKeep APP_ENCRYPTION_KEY in your password manager too: without it, saved data source credentials cannot be read.');
