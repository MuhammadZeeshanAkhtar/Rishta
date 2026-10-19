# Demo video

`output/nikahmate-demo.mp4` — 1080×1920, H.264 High, yuv420p, AAC, 34.8s.

Rebuild it with:

```bash
bash demo/build-demo.sh
```

## What is in it

Every frame under `frames/` is a screenshot of **the actual Expo app** served
from `localhost:8081`, captured at a 9:16 phone viewport. Nothing is a mockup,
a design comp or a rendering of a screen that does not exist.

| Beat | Screen         | What it shows                                               |
| ---- | -------------- | ----------------------------------------------------------- |
| 1    | Title card     | Brand, not the app — and it looks like a title card         |
| 2    | Welcome        | The product's positioning, and the 18+ gate                 |
| 3    | Sign up        | The Article 9 consent checkboxes, before any religious data |
| 4    | Validation     | Four real client-side errors caught at once                 |
| 5    | Sign in        | Supabase auth entry point                                   |
| 6    | Password reset | Deep-link recovery                                          |
| 7    | Outro          | Brand, build status, repository                             |

## What is NOT in it, and why

**Discover, Family review and Chat are built and tested but are not filmed.**

They are gated behind a signed-in session. The app requires a **verified email
address** (`SessionProvider` returns `unverified` otherwise), the development
Supabase project has confirmation emails enabled — confirmed by the auth API
answering `over_email_send_rate_limit`, which is only reachable when it is
trying to send one — and there is no inbox here to confirm from.

Three options were considered and rejected:

- **Disabling email confirmation** on the Supabase project. That is changing a
  security setting on someone's auth system to make a video, which is not a
  trade worth making.
- **Writing directly to `auth.users`** to mark the addresses confirmed. The
  seed script deliberately refuses to touch Supabase Auth at all; forging a
  confirmation to film a demo is the same class of thing.
- **Filming those screens empty or mocked up.** A demo that shows screens the
  viewer could not reach is the one failure mode a demo must not have.

The result is an honest 35 seconds rather than a padded 90. The features are
covered by **1,133 passing tests**, including 23 end-to-end API tests for chat
and 36 for the family layer, and `demo/build-demo.sh` will produce the longer
version unchanged once a verified session is available.

## Demo data

`pnpm --filter @nikahmate/api seed:demo` creates three clearly-labelled members
(`Demo Amina`, `Demo Yusuf`, `Demo Ibrahim`), a family relationship with the
reviewer grants, and a match held at `pending_family_review` by the gate
trigger. It refuses to run against a database holding real members.

Remove it again with:

```bash
pnpm --filter @nikahmate/api seed:demo --clean
```

## The music

Synthesised, not licensed: three sine waves held as a slow pad, low-passed and
given a gentle tremolo so it breathes rather than drones, mixed at −24 dB. It
is an honest answer to "background music" when no licensed track is available,
and it carries no rights problem with the file.
