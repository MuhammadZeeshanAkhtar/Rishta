# 0008 — pnpm workspaces now, Turborepo deferred

**Status:** Accepted · **Date:** 2026-09-24 · **Ref:** README D7, §3

## Context

v1 contains five packages: `apps/mobile`, `apps/admin`, `services/api`,
`packages/domain`, `packages/api-client`, plus `packages/i18n` and `packages/ui`.
The Zod schemas shared between app and API are the point of the structure — they
are what stops business rules drifting into the client.

## Options

| Option                               | For                                                                        | Against                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **pnpm workspaces, Turborepo later** | Shared types work immediately; one less config surface to debug while solo | Task orchestration is manual until Turborepo arrives                    |
| pnpm + Turborepo now                 | Set up once, never revisited                                               | Extra configuration that interacts awkwardly with Expo builds           |
| Separate repos                       | Each simpler alone                                                         | Shared types must be published or duplicated, which defeats the purpose |

## Decision

**pnpm workspaces from Phase 1. Turborepo deferred** until build times justify it.

The asymmetry decides it: a workspace is expensive to retrofit, because every
import path and build config changes. Turborepo is a config file layered onto an
existing workspace. Adopt now what is costly to retrofit; defer what is not.

## Consequences

**Positive.** Shared Zod schemas and generated API client from day one, with less
tooling to maintain.

**Negative.** React Native Metro struggles with pnpm symlinks — `node-linker=hoisted`
in `.npmrc` is required. If it proves troublesome, npm workspaces is a clean
fallback with the same structure.

**Neutral.** Adding Turborepo later requires no restructuring.
