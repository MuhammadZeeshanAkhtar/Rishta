# 0002 — Hybrid backend runtime: Node API primary, Edge Functions for webhooks

**Status:** Accepted · **Date:** 2026-09-24 · **Ref:** README D1, §11

## Context

The decision was deferred until the API surface existed, so it could be made
against real numbers rather than preference. The surface came to ~163 endpoints
for the full product, ~44 needing background work, 11 scheduled jobs (several
heavy), and 10 AI orchestration points.

## Options

| Option                                             | For                                                                                                                                           | Against                                                                                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hybrid: Node API + Edge Functions for webhooks** | Durable queues, real cron, middleware applied once, full observability, no cold starts on messaging; webhooks stay where they are best served | A service to deploy and maintain; ~$10–25/month                                                                                                                                                |
| Edge Functions only                                | No infrastructure; effectively free at this size                                                                                              | No durable queue; execution limits break nightly batch scoring; cold starts hurt p95 on messaging; 163 functions is unmanageable, and one mega-router forfeits the isolation                   |
| App talks directly to Postgres via RLS             | Fastest to start                                                                                                                              | Business logic lands in the client, which breaks the requirement that a future website reuse it; quotas and entitlements become unenforceable; the wali matrix is not expressible in RLS alone |

## Decision

A **Node.js API service is the primary runtime**; Supabase Edge Functions serve the
four webhook receivers.

Revisited once after the team turned out to be solo and MVP scope narrowed to
Option A, which removed ~20 async endpoints (README §11.5). Kept, because the Node
service is needed at v1.1 for Gemini regardless, and migrating a working
~100-endpoint surface at that moment is a worse trade than the monthly cost.

## Consequences

**Positive.** Queues, retries and cost-controlled AI orchestration have somewhere
to live. The OpenAPI contract is runtime-neutral, so this stays reversible.

**Negative.** One more thing a solo developer deploys and monitors. Mitigated by
ADR 0007 (no Redis) and by running a single small instance.

**Neutral.** The Edge-only migration triggers are kept, inverted: if the Node
service proves to be overhead, they are the evidence for collapsing back.
