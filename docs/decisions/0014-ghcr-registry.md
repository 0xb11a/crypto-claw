# ADR-0014 — GHCR as the image registry

**Status:** Accepted
**Date:** 2026-05-09

## Context
SPEC §3 and §17 commit the rewrite to publishing OCI images, but neither section locked which registry. P0b is the first PR that actually publishes, so the choice has to be made here. Three real candidates: GHCR, Docker Hub, AWS ECR. GHCR is already the publish path for the upstream `0xb11a/openclaw` image and authenticates with the workflow-scoped `GITHUB_TOKEN` — no PAT, no separate access-token surface to rotate. Docker Hub introduces free-tier pull rate-limit risk on CI runners and a separate access-token surface. AWS ECR ties auth to AWS IAM, which this project doesn't yet have provisioned. SPEC §17 implies GHCR but didn't lock the choice or the image name.

The image name is a sub-decision that lands here too. SPEC §17 wrote `cryptoclaw` (no hyphen); the repo slug is `crypto-claw` (hyphenated); the workspace package prefix is `@cclaw/*`. The chosen name `crypto-claw` matches `${{ github.repository }}` so the workflow can derive the image path without a hard-coded literal, and no other surface (compose example, runbook, alerts) yet writes the literal. SPEC §17 gets a one-line tweak in the same PR.

## Decision
**Publish OCI images to `ghcr.io/0xb11a/crypto-claw`. The workflow at `.github/workflows/main.yml` derives the path from `${{ github.repository }}` rather than hard-coding it.**

Tag set:
- `:sha-<7chars>` — immutable per-commit, on every push.
- `:v2` — rolling during the rewrite (P0b–P3).
- `:main` — rolling post-cutover (P4+).
- `:vX.Y.Z` and `:latest` — release-please-driven, post-cutover.

No publish to Docker Hub or any other registry unless a future ADR supersedes this.

## Consequences
- **+** GHCR auth uses the workflow-scoped `GITHUB_TOKEN` with `permissions.packages: write`. No PAT to rotate, no Docker Hub access token to manage.
- **+** Free for public images; co-located with source on github.com makes provenance lookups trivial — cosign certificate-identity points at the same repo.
- **+** Pulls inside GitHub Actions are zero-egress (no rate-limit risk on the CI hot path).
- **−** Operators outside GitHub need a personal access token to pull private images. Acceptable while images stay public.
- **−** If `0xb11a/crypto-claw` ever becomes a private repo, GHCR pull permissions need explicit configuration. Documented in runbook.
- Locked: no surface in the repo references Docker Hub or any other registry; image names are derived from `${{ github.repository }}` rather than hard-coded.

Cross-links: ADR-0011 (long-lived `v2` branch — explains the `:v2` rolling tag), ADR-0015 (cosign keyless OIDC — depends on this registry choice for the certificate-identity binding), ADR-0016 (trivy gate — scans this registry's images).
