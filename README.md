# Holo Profiler (hosted)

Holo Profiler as a standalone web app. It keeps the same holographic page you already use: drop a file, see the profile, build rules, and monitor datasets with schedules and exceptions. What changes is where things live:

- **Sign-in:** a magic link by email. Each user gets their own workspace.
- **Storage:** datasets, rule sets, schedules, runs, rule results, exceptions and an audit log are kept in Postgres (Supabase), with row-level security per workspace.
- **Scheduled runs on the server:** a dataset connected to a Snowflake table or an S3 file runs at its scheduled time even when nobody has the page open. The server checks every 15 minutes.
- **Profiling stays local:** files you drop are still profiled in your browser and are never uploaded. Only the results you choose to monitor (profiles, rule results, exceptions) are saved.

The scoring is unchanged. The big ring is still the file score from profiling only, and the rules score is still separate.

## How it is built

| Part | What it is |
| --- | --- |
| `hud/src/` | The page itself: the same engine, rules, operations and UI scripts as the artifact, plus `server-bridge.js` (talks to the app's API), `ui-sources.js` (data sources panel) and `hosted.css`. |
| `scripts/build-hud.mjs` | Builds the page into `lib/hud/hud-html.generated.ts` (served at `/app`) and a standalone copy at `dist/holo-profiler.html`. Runs automatically before `dev` and `build`. |
| `app/` | Next.js 15 App Router: login page, magic-link callbacks, `/app` (the page, signed-in only) and the JSON API under `/api`. |
| `lib/core/` | Server logic in plain JavaScript: the store and merge rules, schedule timing, Snowflake and S3 readers, secret encryption, and the run engine. It reuses `engine.js`, `rules.js` and `ops.js` unchanged. |
| `supabase/migrations/` | The database: tables, row-level security, audit triggers and the scheduler's claim function. |
| `tests/` | Unit tests, a page test in jsdom, and database tests against Postgres. |

### API

All write calls need the header `x-holo: 1` and a same-origin `Origin`, which the page sends automatically.

| Route | Purpose |
| --- | --- |
| `GET /api/store` | Everything in the workspace the page needs at load. |
| `PUT / DELETE /api/store/{collection}/{id}` | Save or remove a dataset, run, exception or setting. Newer server runs and newer steward edits are never overwritten by an older copy of the page. |
| `GET / POST /api/sources`, `DELETE /api/sources/{id}` | Snowflake and S3 connections. Credentials are encrypted and never sent back to the browser. |
| `POST /api/sources/{id}/test` | Checks that a connection works. |
| `GET /api/schedules` | Next run time and last status for each server-run dataset. |
| `POST /api/datasets/{id}/run` | Run a connected dataset on the server now. |
| `GET /api/cron/run-schedules` | Called by the scheduler every 15 minutes, with `Authorization: Bearer $CRON_SECRET`. |
| `GET /api/health` | Whether the app is up, its settings are in place and its database tables exist (names only, never values). |

### Roles

Each workspace has members with a role: **owner** and **admin** can manage data sources, **member** can edit datasets, rules and exceptions, and **viewer** can only read. A new user gets their own workspace as owner. Inviting others into a workspace is done in the database for now (see `workspace_members`); there is no invite screen yet.

### Data sources

- **Snowflake:** key-pair authentication for a service user (no passwords). The private key and its passphrase are encrypted with `APP_ENCRYPTION_KEY` before they are stored, in a table that only the server can read. Tables are read with the table name passed as a bind value, and tables over 200,000 rows are sampled to 200,000 rows, as the page does for large files.
- **S3 (or S3-compatible):** a read-only access key. Point a dataset at a file, or at a folder ending in `/` to use the newest `.csv`, `.tsv` or `.txt` file in it. Files over 250 MB are refused.

## Run it locally

You need Node 20 or later, Docker, and the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started).

```bash
npm install
supabase start                 # starts Postgres, Auth, the API and a mail catcher in Docker
supabase db reset              # applies supabase/migrations
cp .env.example .env.local     # then fill in the values below
npm run gen:secrets            # prints APP_ENCRYPTION_KEY and CRON_SECRET
```

In `.env.local`, set `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` from the output of `supabase status`, `APP_ENCRYPTION_KEY` and `CRON_SECRET` from `npm run gen:secrets`.

```bash
SEED_EMAIL=you@example.com npm run seed   # optional: a user with the two sample files already monitored
npm run dev                                # http://localhost:3000
```

Sign in with your email. Locally, the magic-link email goes to the mail catcher at http://127.0.0.1:54324 instead of a real inbox.

To trigger the scheduler by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/run-schedules
```

The sample files are in `data/`: `sample_claims.csv` (the synthetic P&C claims file the page loads by default) and `wide_claims_250.csv` (250 columns).

## Tests

```bash
npm test          # engine and scoring, exceptions, schedules, crypto, input checks, and the page in jsdom
npm run typecheck
npm run build
```

The database tests need a Postgres 15 or later superuser connection. They create a throwaway database, install a small stand-in for Supabase's roles and `auth.users`, apply the migrations, check row-level security, the store, the audit log and the scheduler end to end, and drop the database at the end:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres npm run test:db
```

Without `TEST_DATABASE_URL` they are skipped.

## What is not covered yet

- No invite screen or workspace switcher; a user works in their first workspace.
- Scheduled runs need a Snowflake or S3 source. A dataset without a source still runs when you drop a matching file on the page, as before.
- The database tests use a stand-in for Supabase Auth, so the magic-link flow itself is only checked against a real Supabase project (see DEPLOY.md).
