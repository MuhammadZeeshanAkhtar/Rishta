# 0007 — Postgres-backed job queue (pg-boss), not Redis

**Status:** Accepted · **Date:** 2026-09-24 · **Ref:** README D1a, §11.5

## Context

ADR 0002 established a Node API service with background jobs. The default choice
would be BullMQ on Redis. The team is one person, and every piece of infrastructure
is something that one person maintains.

## Options

| Option                               | For                                                                                                              | Against                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **pg-boss on the existing Postgres** | No new service; jobs are transactional with the data they concern; one less thing to monitor, secure and pay for | Lower ceiling than Redis; queue load competes with application queries |
| BullMQ + Redis                       | Higher throughput; richer tooling; no migration if volume grows                                                  | An additional service from day one                                     |

## Decision

**pg-boss**, on the Postgres already in use. Redis is added only if queue volume
demands it, which v1 traffic will not.

## Consequences

**Positive.** The production stack is one Node process and one Postgres. A job can
be enqueued in the same transaction as the write that triggers it, so a committed
interest cannot fail to notify.

**Negative.** Queue throughput shares Postgres capacity. Worth watching once
nightly scoring runs against the full base.

**Neutral.** A queue abstraction in `services/api` keeps the swap to Redis a
one-adapter change.
