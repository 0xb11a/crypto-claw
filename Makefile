# crypto-claw — convenience targets

.PHONY: audit test test-offline help

help:
	@echo "make audit         — run npm audit on scripts/ (PR 3.4 gate)"
	@echo "make test          — run full offline test suite"
	@echo "make test-offline  — alias for test"

# PR 3.4: run the same audit gate the pre-commit hook runs. Use this
# before bumping a dependency to see what would block the commit.
audit:
	@cd scripts && npm audit --audit-level=high

test test-offline:
	@cd tests && node run-all.js --offline
