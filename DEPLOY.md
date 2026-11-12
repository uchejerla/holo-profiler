# Deploying Holo Profiler

This puts the app on Vercel with a Supabase project behind it. The repository is set up for the **Vercel Hobby plan** (see section 3). Nothing here has been done yet: each step needs your own accounts.

## 1. Supabase project

1. Create a project at supabase.com. Pick a region near your users and Snowflake account.
2. Apply the database:
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase db push            # applies supabase/migrations
   ```
3. **Authentication > URL Configuration**
   - Site URL: your app's address, for example `https://holo-profiler.vercel.app`.
   - Redirect URLs: add `https://<your-domain>/auth/callback` and `https://<your-domain>/auth/confirm`.
4. **Authentication > Email Templates**: change the link in **both** templates below. The link opens a page with a Continue button, so mail scanners that pre-open links cannot use it up before the person clicks.
   - **Magic Link**:
     ```
     {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/app
     ```
   - **Invite user** (the default invite link does not sign people in to this app):
     ```
     {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/app
     ```
5. **Authentication > Providers > Email**: keep Email enabled. If only your company should sign in, turn off "Allow new users to sign up" after you have signed in once, and add people with **Invite user**.
6. **Authentication > SMTP**: Supabase's built-in mail is limited to a few emails an hour. For real use, set up your own SMTP sender (for example SES, SendGrid or Postmark).
7. **Project Settings > API Keys**: copy the Project URL, the **publishable** key and the **secret** key for step 2. Projects that still show the older keys use `anon` in place of publishable and `service_role` in place of secret; either kind works.

## 2. Vercel project

1. Push this repository to a Git host you choose, then import it in Vercel. The framework is detected as Next.js; no build settings need changing.
2. **Settings > Environment Variables** (Production, and Preview if you use it):

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase publishable key (or legacy `anon`) |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret key (or legacy `service_role`), server only |
   | `APP_ENCRYPTION_KEY` | from `npm run gen:secrets` |
   | `CRON_SECRET` | from `npm run gen:secrets` |
   | `NEXT_PUBLIC_SITE_URL` | your app's address |

   Keep a copy of `APP_ENCRYPTION_KEY` somewhere safe. Without it, saved Snowflake and S3 credentials cannot be read and have to be entered again.
3. Deploy, then open `https://<your-domain>/api/health`. It answers `"ok": true` when every setting is in place and the database tables exist; otherwise it names the setting or step that is missing (never its value).
4. Sign in at `https://<your-domain>/login`. Your first sign-in creates your workspace.

## 3. The scheduler

The app needs something to call `/api/cron/run-schedules` every 15 minutes. Each call runs only the datasets that are due, and each dataset is locked while it runs, so extra or overlapping calls are harmless.

**Hobby plan (how the repository is set up now).** Vercel's Hobby plan allows a cron that runs at most once a day; a more frequent one makes the deploy fail. So:

- `vercel.json` has a once-a-day backup call at 11:00 UTC. Vercel may run it any time within that hour.
- The 15-minute calls come from Supabase. After the first deploy, enable the `pg_cron` and `pg_net` extensions (Database > Extensions), then run `supabase/optional/pg_cron_tick.sql` in the SQL editor with your app's address and `CRON_SECRET` filled in. It keeps both in Supabase Vault rather than in the job itself. The file also has the queries to check it is working and to change or stop it.

**Moving to Pro later.** Run `npm run plan:pro`, commit and push, then stop the Supabase timer with `select cron.unschedule('holo-profiler-tick');`.

Vercel's fair use guidelines limit Hobby to personal, non-commercial use. Move to Pro before you charge anyone for Holo Profiler, use it for your employer's or a client's work, or let other people's work depend on it.

Each server run may take up to 5 minutes (`maxDuration = 300`), which is the Hobby maximum with Fluid compute, the default for new Vercel projects. A run cut off at that limit is tried again on a later call; the app reads at most 200,000 rows per table to stay well inside it. Pro allows longer runs if you ever need them.

## 4. Snowflake key-pair user

Create a service user that can only read the tables you monitor. In a terminal:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -v2 aes-256-cbc -inform PEM -out holo_rsa_key.p8   # asks for a passphrase
openssl rsa -in holo_rsa_key.p8 -pubout -out holo_rsa_key.pub
```

Then in Snowflake (as a role that can create users and grants):

```sql
create role if not exists HOLO_READER;
create user if not exists HOLO_SERVICE
  type = service
  default_role = HOLO_READER
  default_warehouse = <WAREHOUSE>
  rsa_public_key = '<contents of holo_rsa_key.pub without the BEGIN/END lines>';
grant role HOLO_READER to user HOLO_SERVICE;
grant usage on warehouse <WAREHOUSE> to role HOLO_READER;
grant usage on database <DB> to role HOLO_READER;
grant usage on schema <DB>.<SCHEMA> to role HOLO_READER;
grant select on all tables in schema <DB>.<SCHEMA> to role HOLO_READER;
grant select on future tables in schema <DB>.<SCHEMA> to role HOLO_READER;
```

If your account uses a network policy, allow Vercel's outbound addresses or use Vercel's static IP option. In the app, open **Schedules > Data sources**, add a Snowflake source with the account identifier (for example `myorg-myaccount`), user, role, warehouse, the private key file's contents and the passphrase, and press **Test**. Delete the key file from your machine once it works, or keep it in your password manager.

## 5. S3 read-only access

Create an IAM user (or role with access keys) with only this policy, then add an S3 source in the app with its access key:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::<bucket>", "Condition": { "StringLike": { "s3:prefix": ["<prefix>/*"] } } },
    { "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": "arn:aws:s3:::<bucket>/<prefix>/*" }
  ]
}
```

For an S3-compatible store (MinIO, R2 and others), fill in its HTTPS endpoint.

## 6. Rotating the encryption key

There is no automatic re-encryption yet. To change `APP_ENCRYPTION_KEY`, set the new value in Vercel, redeploy, then open each data source in the app, enter its credentials again and test it. Sources that are not re-entered will fail their next run with a clear error.

## 7. Billing (optional)

Without these settings every workspace has every feature. With them, dropping files stays free and **connected sources, "Run on server now" and scheduled runs need the Pro plan**.

1. `supabase db push` to apply the billing migration (adds the plan to each workspace). Do this before setting the keys below.
2. Stripe > Product catalog: add a product (for example "Holo Profiler Pro") with two **recurring** prices: one monthly, and one yearly set below 12 times the monthly price (that gap is the yearly discount; the pricing page works out and shows the percentage). Copy both price IDs (`price_...`).
3. Stripe > Developers > Webhooks: add an endpoint at `https://<your-domain>/api/billing/webhook` for the events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`. Copy its signing secret (`whsec_...`).
4. Stripe > Settings > Billing > Customer portal: turn it on, so customers can change card or cancel from the app's **Billing** button.
5. Vercel > Environment Variables: set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` (monthly), `STRIPE_PRICE_ID_YEARLY`, `STRIPE_WEBHOOK_SECRET` and `NEXT_PUBLIC_SUPPORT_EMAIL` (the address on the refund policy page), then redeploy. The pricing page at `/` reads both prices from Stripe and refreshes hourly. Use Stripe's test mode keys first and pay with card `4242 4242 4242 4242`.

The refund policy customers agree to at checkout is `app/refund-policy/page.tsx`; read it, and have it checked against the law where you and your customers are, before taking live payments.

Existing workspaces start on the free plan. To give one Pro without payment, run in the Supabase SQL editor: `update public.workspaces set plan = 'pro' where id = '<workspace id>';`

## 8. Before real data goes in

- Decide who may sign in (step 1.5) and set up your own SMTP (step 1.6).
- Keep the `service_role` key and `APP_ENCRYPTION_KEY` only in Vercel's environment variables, never in the repository.
- Turn on Supabase's daily backups or point-in-time recovery on a paid plan.
