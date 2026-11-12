# First deploy checklist (Vercel Hobby + Supabase)

The short version of DEPLOY.md, in order. Each box is yours to do, because it uses your accounts and your secrets. Expect about 30 to 45 minutes.

Hobby is free but limited to personal, non-commercial use. Move to Pro before you charge anyone, use Holo Profiler for your employer's or a client's work, or let other people's work depend on it (DEPLOY.md section 3).

## 0. On your own computer

- [ ] Clone the repo and install: `git clone https://github.com/uchejerla/holo-profiler && cd holo-profiler && npm install`.
- [ ] Install the Supabase CLI (supabase.com/docs/guides/local-development/cli/getting-started).
- [ ] Run `npm run gen:secrets` and save both lines (`APP_ENCRYPTION_KEY`, `CRON_SECRET`) in your password manager.

## 1. Supabase (supabase.com, free plan is fine to start)

- [ ] Sign up and create a project. Pick a region near you, for example East US. Save the database password in your password manager.
- [ ] In a terminal in the repo: `supabase login`, then `supabase link --project-ref <ref>` (the ref is in the project's address), then `supabase db push`.
- [ ] Project Settings > API Keys: note the Project URL, the **publishable** key and the **secret** key.

## 2. Vercel (vercel.com, Hobby)

- [ ] Sign up with your GitHub account, then Add New > Project > import **holo-profiler**. Leave the build settings as detected.
- [ ] Before the first deploy, open Environment Variables and add:

  | Name | Value |
  | --- | --- |
  | `NEXT_PUBLIC_SUPABASE_URL` | the Project URL |
  | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the **publishable** key |
  | `SUPABASE_SERVICE_ROLE_KEY` | the **secret** key |
  | `APP_ENCRYPTION_KEY` | from `npm run gen:secrets` |
  | `CRON_SECRET` | from `npm run gen:secrets` |
  | `NEXT_PUBLIC_SITE_URL` | leave for now; set it in step 3 |

- [ ] Press Deploy. Note the address Vercel gives you, for example `https://holo-profiler-xyz.vercel.app`.

## 3. Connect the two

- [ ] Vercel > Settings > Environment Variables: set `NEXT_PUBLIC_SITE_URL` to that address, then Deployments > the latest one > Redeploy.
- [ ] Supabase > Authentication > URL Configuration: Site URL = that address; Redirect URLs: add `<address>/auth/callback` and `<address>/auth/confirm`.
- [ ] Supabase > Authentication > Email Templates > Magic Link: set the link to
  `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/app`
- [ ] Supabase > Authentication > Email Templates > Invite user: set the link to
  `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/app`

## 4. Check it

- [ ] Open `<address>/api/health`. It should say `"ok": true`. If not, it names the setting or step that is missing, never a value.
- [ ] Open `<address>/login`, enter your email, click the link in the email, and drop `data/sample_claims.csv` on the page.
- [ ] Supabase > Authentication > Sign In / Providers: turn off new sign-ups if only people you invite should get in.

## 5. The 15-minute timer (Supabase)

- [ ] Supabase > Database > Extensions: enable **pg_cron** and **pg_net**.
- [ ] SQL Editor: paste `supabase/optional/pg_cron_tick.sql`, replace `<APP_URL>` with your address and `<CRON_SECRET>` with your value, and run it. Don't save the filled-in copy.
- [ ] About 15 minutes later, run the check query at the bottom of that file. `status_code` 200 means the scheduler answered.

Vercel also calls the scheduler once a day at about 11:00 UTC as a backup (Vercel > Settings > Cron Jobs).

## 6. Before others use it

- [ ] Supabase > Authentication > SMTP: your own email sender. The built-in one only sends a few emails an hour.
- [ ] First data source when ready: a Snowflake key-pair user (DEPLOY.md section 4) or a read-only S3 key (section 5), added under Schedules > Data sources, then **Test**.
