# ADR-0016 — trivy CRITICAL-only gate in P0b, tightening in P6

**Status:** Accepted
**Date:** 2026-05-09

## Context
SPEC §16 step 14 requires a vulnerability scan with `severity: HIGH,CRITICAL` and `ignore-unfixed: true`. P0b is the first phase that scans real images. Empirically, `node:22.11.0-bookworm-slim` ships HIGH-rated CVEs that don't apply to a no-network non-root container running compiled JavaScript — kernel CVEs, glibc CVEs in unused syscall paths, libssl CVEs in TLS stacks the prod image doesn't initialize. Failing PRs on those creates noise that masks real findings.

P6 is the dedicated hardening phase per SPEC §18. Distroless final stage, image-digest pinning automation, and the full HIGH+CRITICAL gate all land there. The distroless migration in particular eliminates most of the bookworm-slim HIGH noise organically, which makes the P6 gate tightening cheap rather than disruptive.

## Decision
**In P0b's `main.yml` `scan` job, set `severity: CRITICAL` and `ignore-unfixed: true`. The softening is time-bound to P0b–P5; the P6 hardening PR tightens the gate to `severity: HIGH,CRITICAL` per SPEC §16 step 14.**

This catches CRITICAL CVEs with published fixes and ignores both HIGH-rated noise and findings without an upstream fix. SPEC §16's wording stays at HIGH+CRITICAL — this ADR is the documented bridge between SPEC intent and current CI reality. The P6 PR must reference this ADR-0016 in its description and update the gate alongside the distroless migration.

## Consequences
- **+** PRs don't get blocked by base-image HIGH CVEs unrelated to runtime exposure.
- **+** Real CRITICAL findings still gate publish — the floor is meaningful, not absent.
- **−** A real HIGH finding that does affect us would slip past the CI gate during P0b–P5. Mitigation: SPEC §16 wording remains unchanged (HIGH+CRITICAL); P6 closes the gap; a nightly scan (P0c) can run a stricter gate as a non-blocking advisory.
- **−** Operators reading SPEC §16 first may be surprised by the `pr.yml` and `main.yml` reality. This ADR is the documented bridge; runbook §0.2 cross-references it.
- Locked time-bound: superseded by behaviour automatically when P6 lands. The P6 PR must reference this ADR-0016 in its description and update the gate to `severity: HIGH,CRITICAL`.

Cross-links: ADR-0014 (registry — scans this registry's images), SPEC §16 step 14, SPEC §18 (P6 hardening phase).
