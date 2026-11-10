# Deploying Holo Profiler

This puts the app on Vercel with a Supabase project behind it. Nothing here has been done yet: each step needs your own accounts.

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
4. **Authentication > Email Templates > Magic Link**: change the link so it works even when opened in another browser:
   ```
   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/app
   ```
5. **Authentication > Providers > Email**: keep Email enabled. If only your company should sign in, turn off "Allow new users to sign up" after you have signed in once, and add people with **Invite user**.
6. **Authentication > SMTP**: Supabase's built-in mail is limited to a few emails an hour. For real use, set up your own SMTP sender (for example SES, SendGrid or Postmark).
7. **Project Settings > API**: copy the Project URL, the `anon` key and the `service_role` key for step 2.

## 2. Vercel project

1. Push this repository to a Git host you choose, then import it in Vercel. The framework is detected as Next.js; no build settings need changing.
2. **Settings > Environment Variables** (Production, and Preview if you use it):

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase `anon` key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase `service_role` key (server only) |
   | `APP_ENCRYPTION_KEY` | from `npm run gen:secrets` |
   | `CRON_SECRET` | from `npm run gen:secrets` |
   | `NEXT_PUBLIC_SITE_URL` | your app's address |

   Keep a copy of `APP_ENCRYPTION_KEY` somewhere safe. Without it, saved Snowflake and S3 credentials cannot be read and have to be entered again.
3. Deploy, then open `https://<your-domain>/api/health`. It answers `"ok": true` when every setting is in place and the database tables exist; otherwise it names the setting or step that is missing (never its value).
4. Sign in at `https://<your-domain>/login`. Your first sign-in creates your workspace.

## 3. The scheduler

The app needs something to call `/api/cron/run-schedules` every 15 minutes. Pick one:

- **Vercel Cron (Pro plan).** `vercel.json` already asks for every 15 minutes (`npm run plan:pro`), and Vercel sends `CRON_SECRET` with each call.
- **Supabase pg_cron (Hobby plan).** Vercel's Hobby plan only allows a cron that runs once a day, and a more frequent one makes the deploy fail. Run `npm run plan:hobby` and commit before deploying, which removes the cron from `vercel.json`. After the first deploy, enable the `pg_cron` and `pg_net` extensions in Supabase and run `supabase/optional/pg_cron_tick.sql` in the SQL editor with your app's address and `CRON_SECRET` filled in.

Each server run may take up to 5 minutes (`maxDuration = 300`), which both plans allow with Fluid compute, the default for new Vercel projects. Note that Vercel's fair use guidelines limit the Hobby plan to personal, non-commercial use, so a paid or company deployment needs Pro.

Each tick claims due datasets with a lock, so two overlapping ticks never run the same dataset twice.

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

## 7. Before real data goes in

- Decide who may sign in (step 1.5) and set up your own SMTP (step 1.6).
- Keep the `service_role` key and `APP_ENCRYPTION_KEY` only in Vercel's environment variables, never in the repository.
- Turn on Supabase's daily backups or point-in-time recovery on a paid plan.
