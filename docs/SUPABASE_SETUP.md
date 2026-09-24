# Supabase setup

**What you need to do, once, before Phase 2.**

Everything in the codebase is written against environment variables. Nothing
here needs a password from you, and nobody but you should ever hold these
values.

---

## ⛔ Do not use the Zufishan project

NikahMate gets **its own Supabase organisation and projects**. The existing
Zufishan project must never be selected, connected to, migrated against, or
reused — not for development, not "just to test something".

The reasons are not bureaucratic:

- Our migrations create tables, roles, policies and triggers in `public`. Run
  against an existing project they would collide with, or silently alter, data
  that belongs to something else.
- This schema enables **and forces** row-level security on every table it
  creates, and grants to `anon`, `authenticated` and `service_role`. Those are
  project-wide changes.
- Member data here is GDPR Article 9 special-category data (religion). Mixing it
  into a project with a different purpose and a different lawful basis is a
  compliance problem that is very hard to unpick afterwards.

If you are ever unsure which project a terminal is pointed at, stop and check
the project ref in the URL before running anything.

---

## The three environments

Three **separate Supabase projects**, not three schemas inside one. A bad
migration, a botched policy or an accidental delete must not be able to reach
real members from a dev machine.

| Environment     | Suggested project name | Holds                        | Who connects             |
| --------------- | ---------------------- | ---------------------------- | ------------------------ |
| **Development** | `nikahmate-dev`        | Throwaway seed data only     | Your machine, day to day |
| **Staging**     | `nikahmate-staging`    | Realistic but synthetic data | CI, pre-release testing  |
| **Production**  | `nikahmate-prod`       | Real members                 | The deployed API only    |

**Rules that matter more than the naming:**

1. **Only `nikahmate-dev` credentials ever go in a local `.env`.** Staging and
   production credentials live in the deploy platform's secret store and are
   never written to disk on a laptop.
2. **Never point a local machine at production.** Not to "quickly check"
   something. A `SET ROLE` typo against production is unrecoverable.
3. **Production has no seed data and no test accounts.**
4. Create all three in the **same region**, close to your launch market, and
   keep them consistent. Data residency may later force a specific region — see
   README §15 C3.
5. Turn on **point-in-time recovery** for production before the first real
   member signs up. A backup nobody has tested restoring is not a backup.

### Right now, you only need `nikahmate-dev`

Staging and production can wait until Phase 13. Creating them early means three
projects to keep in sync for no benefit.

---

## Step 1 — create the dev project

1. Sign in to <https://supabase.com/dashboard> with the account that will own
   NikahMate. If that is the same account as Zufishan, create a **new
   organisation** so the projects cannot be confused in a dropdown.
2. **New project** → name `nikahmate-dev`.
3. Choose a strong database password. Save it in your password manager, not in a
   file, not in this repository. You will not need to give it to anyone.
4. Pick a region and note it down.
5. Wait for provisioning to finish.

---

## Step 2 — fill in two files

### 2a. `services/api/.env` — **server-only secrets**

Open **`services/api/.env`**. It already exists with the right variable names
and empty values. Fill in these three:

| Variable              | Where to find it                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`        | **Project Settings → Database → Connection string → URI**. Use the **pooled / transaction mode** string (port `6543`). Replace `[YOUR-PASSWORD]` with the password from step 1.                                    |
| `SUPABASE_URL`        | **Project Settings → Data API → Project URL**. Looks like `https://abcdefgh.supabase.co`                                                                                                                           |
| `SUPABASE_JWT_SECRET` | **Project Settings → JWT Keys**. Fill this in **only** if the project uses a legacy shared secret. If the project uses asymmetric signing keys, **leave it blank** — verification goes through JWKS automatically. |

Leave `SUPABASE_JWKS_URL` blank unless your endpoint is non-standard; it is
derived from `SUPABASE_URL`.

Leave `SENTRY_DSN` blank for now.

> `DATABASE_URL` contains your database password. It is the single most
> sensitive value in this project. It belongs only in this file, which is
> gitignored, and in your deploy platform's secret store.

### 2b. `apps/mobile/.env` — **public client values**

Open **`apps/mobile/.env`** and fill in two:

| Variable                               | Where to find it                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_SUPABASE_URL`             | Same **Project URL** as above                                                                                                                |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | **Project Settings → API Keys** → the **publishable** key (older projects call it **anon**). Starts with `sb_publishable_` or is a long JWT. |

`EXPO_PUBLIC_API_BASE_URL` is already set to `http://localhost:3000`. On an
Android emulator reaching your host machine, change it to `http://10.0.2.2:3000`.

---

## Step 3 — which values are safe where

This is the distinction that matters most.

| Value                      | Client (`apps/mobile`) | Server (`services/api`) | Why                                                                                                                                     |
| -------------------------- | ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Project URL                | ✅ safe                | ✅                      | Just an address                                                                                                                         |
| **Publishable / anon key** | ✅ **safe to ship**    | —                       | Grants nothing on its own. Every table has RLS enabled **and forced**, so this key can only read what a policy permits                  |
| `DATABASE_URL`             | ⛔ **never**           | ✅                      | Full database access with a password                                                                                                    |
| `SUPABASE_JWT_SECRET`      | ⛔ **never**           | ✅                      | Whoever holds it can mint a token for **any** member                                                                                    |
| **Service-role key**       | ⛔ never               | ⛔ **not used at all**  | Bypasses RLS entirely. This service talks to Postgres directly, so it does not need one — and `config.ts` refuses to start if it is set |
| Gemini / any AI key        | ⛔ never               | ⛔ **not used in v1**   | No AI provider is used at all (ADR 0006). The process refuses to start if one is set                                                    |

**Why the publishable key is genuinely safe:** it is not a password. It
identifies the project and nothing more. Authorisation comes from the member's
JWT plus row-level security. If someone extracts it from the APK — and they
can — they get exactly what an anonymous visitor gets: public reference data.

**Anything prefixed `EXPO_PUBLIC_` is compiled into the app bundle.** There is
no such thing as a hidden value in a mobile app. If you would not publish it on
a web page, it does not belong in `apps/mobile/.env`.

---

## Step 4 — what happens next (Phase 2, not now)

Once the values are in, migrations can be applied to `nikahmate-dev`:

```bash
pnpm --filter @nikahmate/db test
```

That runs the full schema and RLS suite against an in-process Postgres first —
no project needed, and it is how the migrations have been verified so far.
Applying them to your real dev project is a Phase 2 step and needs your
go-ahead.

Nothing in this repository has touched a Supabase project yet.

---

## Auth providers (Phase 2)

In **Authentication → Providers**, for `nikahmate-dev`:

- **Email** — enable. Turn **on** "Confirm email".
- **Phone** — enable when you have an SMS provider. It needs a paid provider
  (Twilio, MessageBird) and costs money per message, so it can wait.
- **Google** — enable when you have OAuth credentials.
- **Apple** — required only once iOS ships alongside any other social login.

In **Authentication → URL Configuration**, add the app's redirect scheme:
`nikahmate://` (matches `scheme` in `apps/mobile/app.json`).

---

## Security checklist

Before the first real member exists:

- [ ] Zufishan untouched, and NikahMate in its own organisation
- [ ] Three separate projects, production reachable only from the deployed API
- [ ] No `.env` file committed — `git check-ignore apps/mobile/.env services/api/.env` reports both
- [ ] No service-role key anywhere in the repository or either `.env`
- [ ] No AI provider key anywhere
- [ ] Database password stored in a password manager, not a file
- [ ] Point-in-time recovery enabled on production, and a restore actually tested
- [ ] MFA enabled on your Supabase account
- [ ] Production `DATABASE_URL` only in the deploy platform's secret store

---

## If a secret leaks

Assume it is public the moment it reaches a repository, a chat message or a log.

1. **Rotate immediately** — database password in Project Settings → Database;
   API keys in Project Settings → API Keys.
2. Update the deploy platform's secrets.
3. Rewriting git history does **not** undo exposure. Rotate first, tidy later.
