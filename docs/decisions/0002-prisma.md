# ADR-0002 — Prisma as ORM and migration tool

**Status:** Accepted
**Date:** 2026-05-08

## Context
The legacy DB layer is hand-written `if version < N` migration blocks in `scripts/db.js` plus raw `db.prepare(...)` calls scattered across 79 db-query subcommands. There is no schema source of truth, no typed client, no migration history, no rollback path.

Candidates evaluated: Prisma, Drizzle ORM, TypeORM, Kysely (query builder).

## Decision
**Prisma 6.x.**

Prisma offers: a single schema file as the canonical truth, a fully typed generated client, mature managed migrations (`prisma migrate dev` / `prisma migrate deploy`), `prisma db pull` to bootstrap the schema from the existing populated SQLite DB, and `prisma migrate diff` for drift detection in CI. SQLite and Postgres are both first-class targets, so a future Postgres migration becomes a config + migration change.

## Consequences
- **+** Schema source of truth is `prisma/schema.prisma`; PRs that change DB shape must also produce a migration file (CI gate).
- **+** Typed client eliminates a category of shape-drift bugs in repositories.
- **+** Migration history committed; rollback = prior image tag.
- **−** Engine binary adds ~30 MB to the image; acceptable.
- **−** Some SQLite quirks (no native enums, JSON-as-text columns) require Prisma `@map` and `String` columns with Zod-validated transforms in repositories.
- Locked: `PrismaClient` may only be instantiated inside `libs/prisma`; ESLint rule enforces.
