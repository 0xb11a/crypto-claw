# ADR-0015 — cosign keyless OIDC for image signing

**Status:** Accepted
**Date:** 2026-05-09

## Context
SPEC §16 step 13 requires image signing in `main.yml` but does not name a signing model. Two real choices: cosign keyless via GitHub Actions OIDC (Sigstore Fulcio issues a short-lived cert tied to the workflow run identity, Rekor records the signature in the public transparency log) or cosign with a stored long-lived signing key (private key in repo secrets, public key checked into the repo for verification). Industry direction is decisively keyless — Sigstore graduated, Fulcio + Rekor are production-grade, and the GitHub OIDC binding gives a meaningful answer to "who signed this." Key-based signing introduces a new long-lived secret, key-rotation overhead, and a less-meaningful "who" answer (anyone with secret access).

The keyless verification recipe pins the certificate-identity to the workflow file path. A workflow rename invalidates old verifications; mitigation is to document the regexp in the runbook and surface the trade-off in this ADR.

## Decision
**Sign all OCI images published from `main.yml` with `cosign sign --yes` using GitHub Actions OIDC. The signing job carries `permissions.id-token: write`. No long-lived signing key is generated, stored, or distributed.**

Verification recipe (committed to runbook §0.2):

```
cosign verify \
  --certificate-identity-regexp "^https://github.com/0xb11a/crypto-claw/\.github/workflows/main\.yml@.+$" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/0xb11a/crypto-claw:sha-<7>
```

The same model applies to the SBOM attestation (`cosign attest --type spdxjson`) — same OIDC, same identity binding, same verify pattern via `cosign verify-attestation`.

## Consequences
- **+** No secret to rotate; no key file to leak; verification works without distributing a public key.
- **+** The certificate-identity binding answers "who signed this": the named workflow on the named repo at the named commit ref.
- **+** Transparency log entry (Rekor) provides a public audit trail of every signature event.
- **−** Renaming `.github/workflows/main.yml` invalidates old verify recipes. Mitigated by documenting the regexp in runbook §0.2 and in this ADR.
- **−** Verification requires network access to Sigstore's Fulcio + Rekor at verify time. Air-gapped consumers would need offline verification setup (out of scope here).
- **−** Replaying old signatures requires the original commit ref to still exist on the repo (Sigstore looks up the workflow file).
- Locked: no key-based signing; no `cosign generate-key-pair` usage; no `COSIGN_PRIVATE_KEY` secret in the repo.

Cross-links: ADR-0014 (registry — keyless certs bind to the registry path), ADR-0011 (`v2` branch — workflow file lives here), SPEC §16 step 13.
