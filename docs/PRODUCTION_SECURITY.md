# Production security checklist

What has to be true before real members use this, and who has to do it. Written for the
company's handover. Verified means verified locally: **nothing here has been checked against
a hosted project, a production host or a real device**, unless it says so.

## Release order

Migrations 0026 to 0034 are unapplied. On an empty project, run them all, then start the API.
On a project with data, follow `DATABASE_MIGRATION_REPORT.md`:

```bash
pnpm --filter @nikahmate/api migrate --through=20261106000033
```

Deploy the current API, confirm it serves, then:

```bash
pnpm --filter @nikahmate/api migrate
pnpm --filter @nikahmate/api verify:db
```

0034 removes what the previous API runs on, so it must come after the current API is live.

**Which API is live has not been checked.** Older documents name `6c67581`, the reviewed
commit. `main` is now `75d435b`, so a host that deploys from `main` may be running that instead,
and it would then need migrations through 0031. Find out first, because both start from different
places. Then, measured by running each API's own tests at each step:

| Step           | The live API (`6c67581`)                                                            |
| -------------- | ----------------------------------------------------------------------------------- |
| During the run | Sends fail for the seconds between 0027 and 0033, as 0027 revokes a column it names |
| After 0033     | Keeps working: 555 of 561 tests pass. 0033 lends that column back until 0034        |
| After 0034     | **Stops working**: `GET /me` fails. This is why 0034 must follow the deploy         |

The table is for `6c67581`. The 6 that fail after 0033 change nothing for active members using
the app normally. A free member turning on incognito gets a 500 rather than a refusal (1). A
suspended member's write is refused with a 500 rather than a 403 (1, and 3 more that share its
member). A test says no push tables may exist (1).

**If `75d435b` is live,** 813 of its 850 tests pass after 0033. Chat, interests, family, safety and
notifications all pass. One thing members would notice until the current API is deployed: other
members' photo galleries are empty, and asking to see photos answers "There are no photos to
request" (3 tests). Of the rest, 29 are `verify:db` tests reading new policies, 4 are the suspended
member above, and 1 expected sends to fail. So keep the time between 0033 and the deploy short.

- **Rollback:** up to 0034 the previous API can be restored with no database change. Both APIs
  can also serve at once, so a rolling deploy works, as long as 0034 waits until it has finished.
- **Installed apps and the live site keep working** on the current API: the client code of both
  `6c67581` and `75d435b` passed 68 of 68 checks against it. They also gain the fixes in the API's
  responses, so Express Interest, Accept and Decline stop showing an error for an action that worked.
- **Not proven: that 0033 runs on the hosted database.** `grant authenticated to api_member` needs
  ADMIN OPTION on `authenticated` from Postgres 16, and PGlite cannot show what the hosted
  migration user holds. It runs in a transaction, so a refusal damages nothing, but it would
  stop the release after 0027. Take a backup and rehearse on a copy first, at a quiet time.

## Blockers, in order

| #   | Blocker                                                                                                  | Owner                 |
| --- | -------------------------------------------------------------------------------------------------------- | --------------------- |
| 1   | **Nothing executes a deletion after its grace period.** The app promises it, and Google Play requires it | Company + engineering |
| 2   | Apply the migrations, then run `verify:db` on the hosted project and resolve anything it reports         | Company               |
| 3   | Test Realtime chat on Supabase with the reduced `messages` access from 0034                              | Company               |
| 4   | Set `DATABASE_SSL_CA`. Without it, a remote database connection is refused                               | Company               |
| 5   | Dashboard: remove `public` from the exposed schemas, and check `pg_graphql`                              | Company               |
| 6   | Decide on legacy content, then run `docs/LEGACY_CONTENT_RUNBOOK.md`                                      | Company               |
| 7   | Choose a host. Build and start commands, headers and health check are below                              | Company               |
| 8   | Turn on PITR and test a restore. Storage has no equivalent                                               | Company               |
| 9   | Publish a web deletion page and complete the Play data-safety form                                       | Company               |
| 10  | Test on real Android devices: sign-up, photos, chat, MFA, restricted accounts, deletion                  | Company               |
| 11  | Decide what a member sees when the other person in a chat is suspended or banned (see below)             | Company               |

## Chat with a suspended or banned member

Messages to someone suspended, banned, deactivated or asking for deletion are still accepted and
stored. That person cannot read them, but would on return. Nothing leaks, and the sender is not
told. Closing the thread means deciding what the sender is told about the other person, so it was
left for the company. Either answer is a small change to `app.can_write_message`.

## Account deletion and Google Play

Google Play requires an app that lets people create accounts to let them ask for deletion
in the app, and to offer a web link for the same. It also expects the data to be deleted.

| Requirement                                  | State                                                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Ask from inside the app                      | **Built.** Me tab, every onboarding step, the restricted screen                                           |
| Clear what happens, confirmation, cancelling | **Built.** Grace period from the API, typed confirmation, keep account                                    |
| Actually delete the account and data         | **NOT BUILT.** `maintenance` reports requests past their grace period. Nothing executes them              |
| Web page to ask from                         | **Company.** The web build serves `/delete-account`, but needs hosting, and the link goes in Play Console |
| Data safety form, privacy policy             | **Company**                                                                                               |

**Do not release while the first "not built" stands.** The screen says data is removed after
30 days, because that is the stated policy (ERD E1). Until something does it, that sentence
is untrue. Building it needs Supabase Auth admin access, a scheduler, and counsel's review of
what ERD E1 retains: it is permanent, so it was left for a deliberate decision.

No route reads an open request back, so after an app restart the pending screen shows the
request without its date.

## Data API

From 0034 a member's JWT, used directly, reads and writes nothing in `public`, except three
`messages` columns Realtime needs (`id`, `conversation_id`, `created_at`). The API runs as
`api_member`, which `authenticator` cannot become. This holds whatever the Dashboard says, and
closing the exposure as well means two independent controls.

Do this as well:

1. **Project Settings → Data API → Exposed schemas: remove `public`.** The app uses no Data API
   calls, and the API connects to Postgres directly. Realtime, Auth and Storage do not depend
   on this setting.
2. **Check GraphQL.** `pg_graphql` is reached through `graphql_public` and can reflect `public`
   through the extra search path. Under **Database → Extensions**, disable it, or remove
   `graphql_public` from the exposed schemas. Supabase documents this; it is untested here.
3. Confirm with a member's token that `/rest/v1/profiles` and `/graphql/v1` return no data.

**Test Realtime after 0034.** It cannot run outside Supabase. If new messages stop arriving
live, `grant select on public.messages to authenticated` restores the wider read, at the cost
of message bodies being readable directly by the people in a chat.

## Database connections

Every connection uses `services/api/src/db/tls.ts`. A remote database is verified by default,
and localhost needs nothing. Download the CA from **Project Settings → Database → SSL
Configuration** and set `DATABASE_SSL_CA` to its path or PEM text. `require` and `disable` are
refused for a remote database when `NODE_ENV=production`.

Verified by real TLS handshakes with the real client: an unknown CA, the wrong host,
`?sslmode=no-verify` on the URL and a server refusing TLS are all refused. Not verified against
Supabase's own certificates or its pooler.

## Running the API

`pnpm start` runs through `tsx`, a development tool that a production install does not have.

```bash
pnpm --filter @nikahmate/api build
pnpm --filter @nikahmate/api start:prod
```

`start:prod` is plain Node. Boots and serves in a test, with `NODE_ENV=production`. `start` is
unchanged, so nothing breaks before the host is chosen. Scripts such as `migrate` still use
`tsx`, so run them from a checkout with development dependencies, not from the production image.

## Web build

The web build is the staff console, so it needs a host that can set response headers:

```bash
pnpm --filter @nikahmate/mobile web:export
```

This adds the Content-Security-Policy to the page and writes `dist/_headers`, in the format
Netlify and Cloudflare Pages read. On another host, set the same headers. `frame-ancestors`
and HSTS only work as real headers, not in the page's meta tag.

**It refuses a local, test or non-https address**, because the build bakes them in and the
developer `.env` points the API at localhost. Set the production addresses in the environment.
To try an export on your own machine, use `web:export:local`.

A release build with no API address now stops at start-up and says which setting is missing.
It used to assume localhost, which on a phone is the phone.

`--clear` matters. Metro's cache reuses `EXPO_PUBLIC_*` values from an earlier build, so a build
without it can ship the wrong project's address. This happened during Stage 2 testing.

**Web sessions.** The token is in `sessionStorage`: one tab, gone when it closes. Any script on
the page could still read it, which is what the policy is for. Staff sign in again per tab.
The website in README §19 should use cookie-based sessions, which script cannot read at all.

Not done: staff access restricted by network or SSO.

## Backup and recovery

Nothing in this repository configures backups, and the current state of the hosted project is
unknown.

| Question                   | What is needed                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Database                   | Paid plan with **point-in-time recovery** on, before the first real member                                                |
| Storage (photos)           | **Supabase database backups do not include Storage objects.** Decide how photos are copied, or accept losing them         |
| How much data can be lost? | A company decision (RPO). PITR gives minutes, daily backups a day                                                         |
| How long can it be down?   | A company decision (RTO). Time a real restore                                                                             |
| Has a restore been tested? | **No.** An untested backup is not a backup. Restore into a separate project, run `verify:db`, and record how long it took |
| Secrets                    | Keep the database password, JWT secret and CA somewhere that survives losing the project                                  |

A restored database needs erased members erased again, once deletion exists. Note this in the
restore procedure.

## Pipeline

CI runs on every pull request and push to `main`. It holds no secrets and deploys nothing, and
its token can only read. **Nothing about deployment is in this repository**, so whoever sets it
up should keep migrations a separate, human-approved step.

Company actions, all in GitHub settings:

- **`main` is unprotected, in a public repository.** Require pull requests, a passing CI run and
  at least one review. Block force pushes.
- Turn on secret scanning and Dependabot alerts.
- Use a protected environment with required reviewers for any production deployment.
- Restrict who can publish EAS builds, and keep signing keys out of the repository.

## Dependencies

`pnpm audit`: 40 advisories before Stage 2, 4 after. None critical, and none in the API.

| Package                | Severity       | Where                                                  | Why it remains                                                                                                   |
| ---------------------- | -------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `decode-uri-component` | High, moderate | **In the app**, through `expo-router` → `query-string` | The fix is a newer line `query-string` 7 does not accept. Only affects decoding links on the person's own device |
| `glob`, `minimatch`    | Moderate       | Expo tooling, ESLint                                   | Major version only. Not shipped                                                                                  |

Check again at each Expo upgrade, which is where most of these will go away. CI reports them on
every run.
