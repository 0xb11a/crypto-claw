# crypto-claw — convenience targets

.PHONY: audit check test test-offline help

help:
	@echo "make audit         — run npm audit on scripts/ (PR 3.4 gate)"
	@echo "make check         — run CLAUDE.md ↔ chains.js drift check (PR 4.4 gate)"
	@echo "make test          — run full offline test suite"
	@echo "make test-offline  — alias for test"

# PR 3.4: run the same audit gate the pre-commit hook runs. Use this
# before bumping a dependency to see what would block the commit.
audit:
	@cd scripts && npm audit --audit-level=high

# PR 4.4: dry-run the CLAUDE.md ↔ chains.js drift gate without
# committing. Useful after editing either file to confirm they
# agree before staging.
check:
	@node -e "import('./scripts/pre-commit-check.js').then(async m => { \
	  const { readFileSync } = await import('node:fs'); \
	  const { PORTFOLIO_RULES, getPortfolioRules } = await import('./scripts/chains.js'); \
	  const claudeMd = readFileSync('./CLAUDE.md', 'utf-8'); \
	  const findings = m.findSafetyRuleMismatches(claudeMd, PORTFOLIO_RULES, { solana: getPortfolioRules('solana') }); \
	  if (findings.length === 0) { console.log('CLAUDE.md ↔ chains.js: in sync'); process.exit(0); } \
	  console.error('Drift detected:'); for (const f of findings) console.error(' ', JSON.stringify(f)); process.exit(1); \
	})"

test test-offline:
	@cd tests && node run-all.js --offline
