# ADR-0013 — Node 22.11.0 minor-version pin

**Status:** Accepted
**Date:** 2026-05-09

## Context
SPEC §3 already commits the rewrite to "Node 22 LTS." That's the major; it doesn't say which minor. During P-prep / P0a we found three load-bearing surfaces in the repo where the version is consumed and which disagree silently if left to float: `.nvmrc` (driving `nvm use` and `actions/setup-node@v4`'s `node-version-file`), `package.json#engines.node` (enforced by `pnpm install` — the `WARN Unsupported engine` line already fires on Node 24 in our local environment), and `docker/Dockerfile`'s builder + prod stages (`FROM node:22.11.0-bookworm-slim`). With a floating `22` or `22-lts` tag, each of these resolves independently per machine and per CI run.

Candidates evaluated: float on `22` (track latest LTS minor), pin minor to `22.11.0`, pin patch exactly. The CI cost of floating is concrete: `actions/setup-node@v4` derives part of its cache key from the resolved Node version, so a minor bump invalidates the pnpm store cache and undoes the P0 CI step-time work. Native modules (`better-sqlite3`, `@swc/core`, `esbuild` transitively via `tsx` and `vitest`) ship pre-built binaries per Node ABI minor; a mismatch forces a from-source rebuild on CI machines. And operator-machine drift — two engineers on different `nvm install 22` snapshots — has historically surfaced as inconsistent bug profiles in pino, undici, and Vitest's worker pool. Pinning the patch exactly was rejected because Node 22.x patches are security and correctness fixes; refusing them is worse than the variance they cause.

## Decision
**Pin Node minor to `22.11.0` across all three surfaces — `.nvmrc`, `package.json#engines` (`>=22.11.0 <23`), and the Dockerfile base image — and bump the floor minor only in a deliberate PR.**

The `>=22.11.0 <23` range accepts patch bumps above the floor without code change, which is the right granularity for security fixes. Bumping the floor minor (e.g. to `22.12.0`) is a manual, deliberate PR that touches all three surfaces in lockstep, triggered by either a security-driven LTS bump or a feature in a later minor we want to depend on. Floating tags like `22` or `22-lts` are not used anywhere. Dockerfile digest pinning (`node:22.11.0-bookworm-slim@sha256:…`) is a separate hardening item parked for P0b alongside multi-arch + cosign + trivy.

## Consequences
- **+** CI cache keys stay stable across PRs; the P0 pnpm-store cache work isn't undone on every Node minor release.
- **+** One Node ABI minor across local, CI, and production images — pre-built native binaries are used everywhere, no from-source rebuilds of `better-sqlite3` / `@swc/core` / `esbuild`.
- **+** Local-vs-CI parity by default: an engineer running `nvm use` gets the same minor the Dockerfile builds against.
- **−** Operator burden: every Node LTS minor bump is a small, deliberate PR touching three surfaces. A future ADR may consolidate the source-of-truth into a single file (e.g. a top-level `.tool-versions` consumed by `mise` / `asdf`) if this drift becomes a recurring problem.
- **−** Engineers running Node 24 locally see a `WARN Unsupported engine` line on every `pnpm install`. This is intended and harmless; the runbook flags it.
- Followup (P0b): pin the Dockerfile base by digest once the multi-arch + cosign + trivy hardening lands.
- Locked: no surface in the repo references a floating Node tag (`22`, `22-lts`, `lts/*`); the three surfaces stay in lockstep, and the floor minor moves only via a superseding ADR or a deliberate bump PR cross-referencing this one.
