# First deploy checklist

The short version of DEPLOY.md: about 30 minutes of clicking. Each box is something only you can do, because it uses your accounts.

## Before you start

- [ ] Pick the Vercel plan. **Pro** (USD 20 a month per developer seat) runs schedules every 15 minutes and is required for commercial use. **Hobby** is free but personal and non-commercial only, and needs the Supabase timer in step 4.
- [ ] If Hobby: run `npm run plan:hobby` and commit, or the deploy fails on the 15-minute cron.
- [ ] Run `npm run gen:secrets` on your own computer and keep both values in your password manager.

## 1. Supabase (supabase.com)

- [ ] New project. Region close to your users and to Snowflake (for example East US).
- [ ] `supabase login`, `supabase link --project-ref <ref>`, `supabase db push`.
- [ ] Authentication > URL Configuration: Site URL = your app address. Redirect URLs: `<app>/auth/callback` and `<app>/auth/confirm`.
- [ ] Authentication > Email Templates > Magic Link: link becomes `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/app`
- [ ] Authentication > SMTP: your own sender before inviting others (the built-in one sends only a few emails an hour).
- [ ] Project Settings > API: copy the Project URL, `anon` key and `service_role` key.

## 2. Vercel (vercel.com)

- [ ] Add New > Project > import the GitHub repo. Leave build settings as detected.
- [ ] Environment Variables (Production):
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `APP_ENCRYPTION_KEY`
  - `CRON_SECRET`
  - `NEXT_PUBLIC_SITE_URL` (your app address)
- [ ] Deploy.

Optional check first: paste the same values into a local file and run `npm run check:env -- that-file --production`. It prints only names and problems, never values.

## 3. Check it

- [ ] Open `<app>/api/health`. It should say `"ok": true`. If not, it names what is missing.
- [ ] Open `<app>/login`, sign in with your email, and drop `data/sample_claims.csv` on the page.
- [ ] Back in Supabase: Authentication > Providers > Email, turn off new sign-ups if only invited people should get in.

## 4. Schedules

- [ ] **Pro:** nothing to do. Vercel > Settings > Cron Jobs shows the 15-minute job.
- [ ] **Hobby:** Supabase > Database > Extensions, enable `pg_cron` and `pg_net`, then run `supabase/optional/pg_cron_tick.sql` in the SQL editor with your app address and `CRON_SECRET` filled in. Don't commit the filled-in copy.

## 5. First data source (when ready)

- [ ] Snowflake: create the key-pair service user (DEPLOY.md section 4), add it under Schedules > Data sources, press Test.
- [ ] S3: read-only IAM key (DEPLOY.md section 5), add it the same way.
- [ ] Point a monitored dataset at a table or file and press **Run on server now**.
