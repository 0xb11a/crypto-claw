---
name: audit-instructions
description: "Audit all agent instruction files for consistency, correctness, and completeness. Use when the user mentions audit, review, consistency check, instruction drift, check agents, or wants to verify that markdown instruction files are in sync with source-of-truth code files."
---

# Instruction Audit Skill

You are auditing CryptoClaw's agent instruction files for consistency against source-of-truth code files. Perform all 5 passes below systematically, then produce a single structured report.

## Files to Read

### Source-of-Truth Files
- `scripts/db-query.js` — extract all valid command names (look for the command dispatch/switch)
- `scripts/chains.js` — portfolio rules, chain config, numeric constants
- `scripts/` directory listing — all valid script filenames
- `build-templates.sh` — which scripts get deployed to which agent (Docker path)
- `setup.sh` — which scripts get deployed to which agent (bare-metal path)

### Instruction Files to Audit
- `agents/research/AGENTS.md`
- `agents/research/SOUL.md`
- `agents/research/HEARTBEAT.md`
- `agents/research/skills/discovery/SKILL.md`
- `agents/research/skills/analyst/SKILL.md`
- `agents/research/skills/risk/SKILL.md`
- `agents/research/skills/portfolio/SKILL.md`
- `agents/sentinel/AGENTS.md`
- `agents/sentinel/SOUL.md`
- `agents/sentinel/HEARTBEAT.md`
- `agents/sentinel/skills/sentinel/SKILL.md`
- `agents/executor/AGENTS.md`
- `agents/executor/SOUL.md`
- `agents/executor/HEARTBEAT.md`
- `agents/executor/skills/executor/SKILL.md`
- `agents/observer/AGENTS.md`
- `agents/observer/SOUL.md`
- `agents/observer/HEARTBEAT.md`
- `agents/observer/skills/triage/SKILL.md`
- `agents/research/TOOLS.md`
- `agents/sentinel/TOOLS.md`
- `agents/executor/TOOLS.md`
- `agents/observer/TOOLS.md`

## Audit Procedure

### Pass 1: Command Validity (mechanical)

1. Read `scripts/db-query.js` and extract every valid command name from the command dispatch logic (the switch/case or if-else chain that maps CLI arguments to functions).
2. Read every instruction file listed above and extract all `db-query.js <command>` references (match patterns like `db-query.js get-positions`, `db-query.js add-trade`, etc.).
3. For each command reference found in instruction files, check if it exists in the extracted valid commands list.
4. **Flag as CRITICAL** any command reference that doesn't match a real command — this would cause agent runtime failures.

### Pass 2: Script References (mechanical)

1. List all `.js` files in `scripts/`.
2. Read every instruction file and extract all `node scripts/<file>` or `scripts/<file>` references.
3. **Flag as CRITICAL** any reference to a script file that doesn't exist in `scripts/`.
4. Read `build-templates.sh` and `setup.sh` to determine which scripts are deployed to each agent.
5. **Flag as WARNING** any script referenced in an agent's instruction files that is NOT deployed to that agent (the agent won't have access to it at runtime).

### Pass 3: Constant Consistency (semi-mechanical)

1. Read `scripts/chains.js` and extract all numeric portfolio rule constants (position limits, cash reserves, slippage limits, etc.).
2. Read all instruction files and extract numeric constants from portfolio rule tables, safety rules, and limit references.
3. **Flag as CRITICAL** any mismatch between a markdown-stated value and the corresponding `chains.js` value — the code will enforce the `chains.js` value regardless of what the instructions say.
4. Check that regime adjustment tables (if present in multiple files) are identical across all files that contain them.
5. **Flag as WARNING** any regime table discrepancy.

### Pass 4: Cross-File Behavioral Consistency (semantic)

1. For each agent, compare AGENTS.md against its SKILL.md files:
   - Look for the same behavior described with different thresholds, actions, or field names.
   - **Flag as WARNING** any inconsistency.
2. Compare HEARTBEAT.md scan parameters (intervals, batch sizes, limits) against SKILL.md defaults.
3. Check that sell order JSON field names are consistent between sentinel instruction files and executor instruction files (the executor must parse what the sentinel writes).
4. Check that trade proposal JSON field names are consistent between research instruction files and executor instruction files.
5. Verify paper mode command mapping is complete — every agent that references paper mode should use the correct `paper_*` variant commands.

### Pass 5: Completeness (semantic)

1. Every `db-query.js` command documented in an agent's `TOOLS.md` should appear in that agent's instruction files (AGENTS.md, HEARTBEAT.md, SKILL.md). Cross-check each agent's `agents/{name}/TOOLS.md` against its own instructions. **Flag as INFO** any command documented in an agent's TOOLS.md but never referenced by that agent. Also flag any command in an agent's TOOLS.md that the agent doesn't have access to (per `build-templates.sh`/`setup.sh` script deployment).
2. Every script deployed to an agent (per `build-templates.sh`/`setup.sh`) should be referenced in that agent's instruction files. **Flag as INFO** any deployed-but-unreferenced scripts.
3. Every safety rule stated in an agent's AGENTS.md should have a corresponding check or reference in at least one of that agent's SKILL.md files. **Flag as INFO** any safety rule without a skill-level reference.

## Output Format

Produce the report in exactly this format:

```
## Instruction Audit Report — YYYY-MM-DD

### CRITICAL (would break agent behavior)
- [file:line] description of the issue + suggested fix

### WARNING (inconsistency, unclear intent)
- [file:line] description + question about which value is correct

### INFO (completeness gaps, style)
- description

### Summary
- X critical, Y warnings, Z info items
- Files audited: N
- Commands checked: N
- Scripts checked: N
```

If a section has no findings, include it with "None found."

## Important Notes

- Read files carefully and completely — do not skim or sample.
- Use line numbers when reporting issues so they can be located quickly.
- For CRITICAL issues, always suggest a specific fix.
- For WARNING issues, ask which value is correct rather than assuming.
- Do not modify any files — this is a read-only audit.
- If you cannot determine the correct value, say so and flag it for human review.
