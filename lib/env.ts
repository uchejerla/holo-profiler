// Environment, read lazily so `next build` works without secrets present.
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return v;
}
export const env = {
  supabaseUrl: () => need('NEXT_PUBLIC_SUPABASE_URL'),
  supabaseAnonKey: () => need('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  serviceRoleKey: () => need('SUPABASE_SERVICE_ROLE_KEY'),
  encryptionKey: () => need('APP_ENCRYPTION_KEY'),
  cronSecret: () => need('CRON_SECRET'),
  siteUrl: () => process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000',
};
