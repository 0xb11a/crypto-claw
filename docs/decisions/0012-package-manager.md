# ADR-0012 — pnpm

**Status:** Accepted
**Date:** 2026-05-08

## Context
The monorepo has four apps and ~22 shared libraries. We need a package manager with first-class workspace support, a fast install path that won't dominate CI time, and a lockfile we can pin and audit.

Candidates evaluated: npm, pnpm, yarn (Berry).

## Decision
**pnpm 9.x.**

- Native workspaces via `pnpm-workspace.yaml`.
- Content-addressable store reduces install time and image size; especially valuable for the multi-arch CI build.
- `pnpm-lock.yaml` committed; `pnpm install --frozen-lockfile` in CI and Dockerfile.

## Consequences
- **+** Faster CI installs, smaller `node_modules`, smaller container layers.
- **+** Strict default install (no phantom deps) catches missing `package.json` entries at install time.
- **+** Workspace protocol (`workspace:*`) for cross-package refs without publishing.
- **−** A handful of npm-specific tooling expectations break (e.g., some Husky / lint-staged docs). Trivial to adapt.
- Locked: no `npm install`, `yarn add`, or hand-edited `package-lock.json` in the repo.
