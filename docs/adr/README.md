# Architecture Decision Records

Each ADR records one decision: the context, the options weighed, what was chosen,
and what it costs. They are immutable once accepted — a decision that changes gets
a **new** ADR that supersedes the old one, rather than an edit that erases the
reasoning.

For a solo build this is the substitute for code review: the record of why, so a
choice can be re-examined later without re-deriving it from scratch (R15).

| #                                                   | Decision                                                       | Status   |
| --------------------------------------------------- | -------------------------------------------------------------- | -------- |
| [0001](0001-deterministic-compatibility-scoring.md) | Deterministic compatibility scoring, Gemini layered on top     | Accepted |
| [0002](0002-hybrid-backend-runtime.md)              | Hybrid backend runtime: Node API + Edge Functions for webhooks | Accepted |
| [0003](0003-phasing-style.md)                       | Horizontal foundations, then vertical feature slices           | Accepted |
| [0004](0004-five-tab-navigation.md)                 | Five main tabs, including a dedicated Family tab               | Accepted |
| [0005](0005-mvp-scope-option-a.md)                  | MVP scope: core loop, safety, and a wali Observer tier         | Accepted |
| [0006](0006-gemini-data-governance.md)              | Gemini data governance principle; access tier deferred         | Accepted |
| [0007](0007-postgres-backed-job-queue.md)           | Postgres-backed job queue (pg-boss), not Redis                 | Accepted |
| [0008](0008-pnpm-workspaces-no-turborepo.md)        | pnpm workspaces now, Turborepo deferred                        | Accepted |
| [0009](0009-consolidated-entity-design.md)          | Consolidated entity design: 90 entities                        | Accepted |
| [0010](0010-launch-locales-english-and-urdu.md)     | Launch locales: English and Urdu only                          | Accepted |

## Constraints set by the product owner

These are not ADRs because they were not open decisions — they are the givens the
architecture was designed around. Recorded so their origin is not mistaken for a
technical choice later.

| Constraint                                             | Set                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| React Native + Expo, TypeScript, Android first         | Product direction                                           |
| Supabase for auth, database, storage, realtime         | Product direction                                           |
| Gemini for AI features                                 | Product direction                                           |
| English + Urdu at launch; Arabic deferred              | Recorded as [0010](0010-launch-locales-english-and-urdu.md) |
| Website and admin panel reuse the same backend         | Product direction                                           |
| Each person owns their own profile; wali by invitation | Product direction                                           |
| Both men and women may send interest                   | Product direction                                           |
| Marriage platform, not casual dating                   | Product direction                                           |
| Solo developer                                         | Team constraint — drives 0002, 0005, 0007, 0008             |
