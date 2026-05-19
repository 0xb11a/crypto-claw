---
name: audit-instructions
description: "Full-corpus audit of CryptoClaw agent instruction files — checks referential consistency against source-of-truth code AND structural/prose integrity so accreted edits don't mislead an LLM. Use whenever the user mentions audit, review, consistency check, instruction drift, structural cleanup, check agents, or asks to verify that AGENTS.md / HEARTBEAT.md / SOUL.md / SKILL.md / TOOLS.md / CLAUDE.md files are in sync with each other and with the code. Trigger even if the user only says 'audit the agents' or 'the instructions are getting messy' — this skill is the right tool."
---

# Instruction Audit Skill

You are auditing CryptoClaw's instruction corpus — the markdown files that tell the four agents (Research, Sentinel, Executor, Observer) how to behave. The corpus drifts in two distinct ways and this skill catches both:

1. **Referential drift.** Commands get renamed, constants change in `chains.js`, heartbeat cadences shift in `entrypoint.sh` — but the markdown still references the old names. An agent invokes a dead command and crashes.
2. **Structural drift.** Edits land as bolt-ons ("step 3b." inserted between 3 and 4), new rules duplicate old ones with slightly different wording, cross-refs dangle after sections move, terminology fragments (`smart_money` vs `smart money` vs `smart-money`). An LLM reading the instructions gets confused about which rule to follow.

Run all passes in order and produce a single structured report. The guiding question for every finding is: **"would an LLM reading this execute correctly?"** If yes, don't flag. If no, flag with severity matched to impact.

## Scope

### Pass 0 — Grounding (read first, no findings)

Before any audit pass, read two files end-to-end:

1. **`CLAUDE.md` at repo root.** The project's single-page orientation: four agents, two-layer memory, data flow, wallet pipeline, safety rules, conventions. You need this context to distinguish intentional repetition (e.g. safety rules stated in both Research and Executor by design) from drift (the same rule stated with different numbers). Post-retained-deletion, the legacy `scripts/` inventory in CLAUDE.md lists only ~10 retained files (log.js, redact.js, promote-pattern.js, emergency-executor.js, emergency-sentinel.js, heartbeat-check.js, pre-commit-check.js, memory-backup.sh, codex-login.sh, ci/*.mjs) — db.js, db-query.js, chains.js, order-approval.js, and agent-idleness.js were deleted after porting heartbeat-check.js / promote-pattern.js / emergency-*.js off db.js to use cclaw. `send-alert.js` was deleted in P5c (superseded by `cclaw alerts send`).
2. **`entrypoint.sh`.** This is where OpenClaw is configured — the project has **no standalone `openclaw.json` file**. All runtime settings (`reserveTokensFloor`, `memoryFlush.softThresholdTokens`, `HEARTBEAT_CADENCES` gates, per-agent tool allowlists, cron `--every` intervals, `agents.list[N]` overrides) are applied via `openclaw config set` CLI calls in this file. Passes 3b, 3c, 10, and 12 all read from it. Do not look for `openclaw.json`; do not warn operators to create one.

No findings are emitted from Pass 0. It just primes you.

### Source-of-truth files

These are the code files the markdown must stay in sync with. The code wins in every discrepancy — the agent will execute what the code enforces regardless of what the markdown says.

- `libs/modules/heartbeat/src/cadences.ts` — `HEARTBEAT_CADENCES` object (minutes per check per agent) AND `AGENT_HEARTBEAT_INTERVALS` (outer loop cadences per agent). This is the canonical post-retained-deletion source; `scripts/db-query.js` was deleted.
- `libs/chain/src/portfolio-rules.ts` — portfolio rule constants (position limits, cash reserves, slippage) — **canonical post-P5**. `scripts/chains.js` was deleted in the retained-set deletion follow-up.
- `prisma/schema.prisma` — SQLite schema (tables, columns). `scripts/db.js` was deleted in the retained-set deletion follow-up.
- `scripts/` directory listing — the retained script filenames (~10 files post-retained-deletion).
- `sdk/cclaw/src/index.ts` — canonical cclaw command surface.
- `build-templates.sh` — which scripts get deployed to which agent.
- `entrypoint.sh` — sole OpenClaw config surface. Read for:
  - cron schedules (`--every <interval>` per agent, used by Pass 3b)
  - `openclaw config set 'agents.defaults.compaction.reserveTokensFloor' <N>` (used by Pass 10)
  - `openclaw config set 'agents.defaults.compaction.memoryFlush.softThresholdTokens' <N>` — or the inline JSON form on the `…memoryFlush '{…,"softThresholdTokens":N,…}'` line (used by Pass 10)
  - per-agent overrides `agents.list[<idx>].compaction.…` and `agents.list[<idx>].heartbeat.…`
  - `openclaw agents add <name>` call order — defines the `agents.list[idx]` → agent-name mapping for every per-agent override.

### Instruction files to audit

Agent-facing (each agent sees only its own):
- `agents/research/{AGENTS,SOUL,HEARTBEAT,TOOLS}.md` + `agents/research/skills/{discovery,analyst,risk,portfolio,orders}/SKILL.md`
- `agents/sentinel/{AGENTS,SOUL,HEARTBEAT,TOOLS}.md` + `agents/sentinel/skills/sentinel/SKILL.md`
- `agents/executor/{AGENTS,SOUL,HEARTBEAT,TOOLS}.md` + `agents/executor/skills/executor/SKILL.md`
- `agents/observer/{AGENTS,SOUL,HEARTBEAT,TOOLS}.md` + `agents/observer/skills/{triage,create-gh-issue}/SKILL.md`

Project-level (also audited for drift vs code):
- `CLAUDE.md`

## Severity levels

Findings land in one of four buckets. Choose based on consequence, not on how mechanical the detection was.

- **CRITICAL** — An agent will fail, crash, or produce wrong behavior at runtime. Example: a documented command that doesn't exist in `db-query.js`.
- **STRUCTURE** — The markdown is still technically correct but an LLM reading it will be misled, confused, or biased to ignore a rule. Example: a new step inserted as "3b." after an existing numbered list, or the same concept spelled three different ways.
- **WARNING** — Drift or inconsistency that may or may not cause a problem; human judgment needed. Example: regime tables in two files that differ by one row.
- **INFO** — Completeness or style signal, low urgency. Example: a command in TOOLS.md that the agent never invokes.

## Audit procedure

Each pass describes what it checks, why it matters, and the severity it assigns. Every finding must cite `file:line` and, where relevant, the rule ID below.

### Pass 1 — Command validity (mechanical)

**Why:** If an agent exec's a command that `db-query.js` or the `cclaw` CLI doesn't recognize, it crashes mid-heartbeat. Silent runtime failure is among the worst outcomes because Observer may not catch it immediately.

**As of P5b, `cclaw` is the sole agent-markdown CLI surface.** All agent markdown must use `cclaw <resource> <action>`. There are ZERO acceptable `node scripts/db-query.js` references in agent markdown post-P5b (see Pass 1.5).

1. Extract every valid command name from the canonical source:
   - **cclaw surface:** the `.command(...)` calls in `sdk/cclaw/src/index.ts` — produces the command map `cclaw <resource> <action>` (e.g. `cclaw positions list`, `cclaw orders approve`, `cclaw heartbeat ping`). The P5b expansion added: `system chains`, `system chain-config`, `system portfolio`, `system cash get`, `system cash set`, `system gas`, `system meta get`, `system meta set`, `system sync-status`, `system sync-portfolio`, `system trade-stats`, `system audit`, `orders cancel`, `orders retry`, `orders history`, `orders execute`, `positions set-onchain-balance`, `watchlist list`, `watchlist add`, `watchlist update`, `watchlist remove`, `contracts list`, `contracts add`, `liquidity list`, `liquidity add`, `analysis check`, `analysis cache`, `analysis list`, `analysis clear-expired`, `wallets list`, `wallets add`, `wallets propose`, `wallets unscored`, `wallets update-score`, `wallets remove`, `wallets signals`, `logs research list`, `logs research append`, `logs sentinel list`, `logs sentinel append`, `logs executor list`, `logs executor append`, `logs observer list`, `logs observer append`.
2. Grep every instruction file for:
   - `cclaw <resource> <action>` references — verify each exists in the cclaw command map from `sdk/cclaw/src/index.ts`.
   - `db-query.js <command>` references in agent markdown — flag CRITICAL (zero allowed post-P5b).
3. For each `cclaw <resource> <action>` match, verify it exists in the cclaw command map.
4. **Flag as CRITICAL** any `node scripts/db-query.js` reference found in agent markdown files (agents/ directory). This is a definitive post-P5b violation.
5. **Flag as CRITICAL** any referenced `cclaw` command that doesn't exist in the command map. Include the suggested real command if the difference is a typo.

### Pass 1.5 — Retained legacy whitelist (mechanical)

**Why:** After P5b, `cclaw` is the sole agent-markdown CLI surface. `db.js`, `db-query.js`, `chains.js`, `order-approval.js`, and `agent-idleness.js` were deleted in the retained-set deletion follow-up (post-P5b). Any `node scripts/db-query.js` reference in agent markdown is **CRITICAL**.

**Agent markdown rule (post-P5b):** `grep -r "node scripts/db-query.js" agents/` MUST return zero matches. Any match is CRITICAL — the P5b markdown sweep eliminated all 172 hold-back references.

**Retained scripts whitelist** (scripts that still exist on disk — the file-level whitelist below is for Pass 2 validation of `node scripts/<file>` non-db-query references in instruction text):
- `scripts/log.js` — retained (required by heartbeat-check.js, emergency-sentinel.js, emergency-executor.js, promote-pattern.js)
- `scripts/redact.js` — retained (required by log.js and promote-pattern.js)
- `scripts/promote-pattern.js` — retained (MEMORY.md write-protection; uses cclaw for derived-from verification)
- `scripts/emergency-executor.js` — retained (entrypoint.sh loop; uses cclaw orders execute)
- `scripts/emergency-sentinel.js` — retained (entrypoint.sh loop; uses cclaw orders propose + approve)
- `scripts/heartbeat-check.js` — retained (entrypoint.sh SKIP predicate; uses cclaw positions/orders list)
- `scripts/pre-commit-check.js` — retained (CI infrastructure)
- `scripts/memory-backup.sh` — retained (SPEC §8)
- `scripts/codex-login.sh` — retained (operator OAuth setup)
- `scripts/ci/*.mjs` — retained (CI guards)

**Flag as CRITICAL** any `node scripts/<file>` reference in agent instructions where `<file>` is NOT in the whitelist above (e.g. `node scripts/process-order.js`, `node scripts/send-alert.js`, `node scripts/db-query.js`). Also flag as CRITICAL any `node scripts/db-query.js` reference in agent markdown — all hold-backs were eliminated in P5b.

### Pass 1c — Agent markdown vs `@Identities(...)` cross-check (P7 PR-C1, plan Decision 15)

**Why:** Agent markdown files reference `cclaw <resource> <action>` commands. Each command maps to an HTTP route. Each route has an `@Identities(...)` decorator that restricts which identities may call it. If a markdown file documents a command for an agent whose identity is excluded from that route's `@Identities(...)` allowlist, the agent gets a 403 when enforce mode flips (`AUTHZ_SHADOW_MODE=0`, PR-C2).

**LLM-agent gap (runbook §16.5):** Today all LLM-agent cclaw calls identify as LOOP (the gateway wires `CCLAW_API_TOKEN=${LOOP_API_KEY}`). So the cross-check logic is:

- **Flag CRITICAL** if the route's `@Identities(...)` excludes **LOOP** — any LLM agent calling this command today will get a 403 even in shadow mode (BearerAuthGuard passes, RolesGuard passes, IdentityGuard blocks in enforce).
- **Do NOT flag** if the route excludes the specific named identity (RESEARCH/SENTINEL/etc.) but includes LOOP — this is expected today. The per-agent token plumbing (PR-B) is what would make the named-identity check load-bearing.

**Procedure:**

1. For each agent, extract every `cclaw <resource> <action>` command from `agents/{name}/{HEARTBEAT,TOOLS}.md` and `agents/{name}/skills/*/SKILL.md`.
2. For each command, map it to the underlying HTTP route using `sdk/cclaw/src/index.ts` (the `.command(...)` calls define the mapping from CLI command to HTTP verb + path).
3. For each route, find the `@Identities(...)` decorator by grepping `libs/modules/**/*.controller.ts` and `libs/audit/src/audit.controller.ts` for the matching path segment.
4. Apply the LLM-agent gap rule:
   - `@Identities('*')` or `@Identities(..., 'LOOP', ...)` → pass (LOOP is allowed, today's agents can call this).
   - `@Identities(...)` WITHOUT 'LOOP' and WITHOUT '*' → **CRITICAL**: the agent's cclaw call will 403 in enforce mode.
5. Separately, for informational completeness, flag **INFO** any route where `@Identities(...)` includes the named agent identity but excludes LOOP (forward-compat: after PR-B this agent can use its per-agent token and the route will work, but today it calls as LOOP and may get 403 in enforce mode if LOOP is absent).

**Note on DASHBOARD:** `cclaw alerts ack` is documented for Research. The underlying route `POST /v1/alerts/:id/acknowledge` has `@Identities('*')` — this is a sanctioned exception (ADR-0029 "Sanctioned `@Identities('*')` exceptions"). Do not flag it.

### Pass 1b — Compound-command preflight (mechanical)

**Why:** OpenClaw's exec preflight rejects compound commands. A bash fence containing `cmd-a && cmd-b` is not a slower-path — it's a **silent rule deletion at runtime**: the agent reads the step, tries to execute, preflight blocks it, and the agent either invents a workaround (hallucination) or stalls. CLAUDE.md's "Common Pitfalls" lists this as the project's #1 instruction-authoring trap; every per-agent TOOLS.md carries the "one command per exec call" rule for the same reason. The audit must enforce it mechanically.

1. For every instruction file in scope, walk each fenced code block whose language tag is `bash`, `sh`, `shell`, `zsh`, or empty with a shell-ish opening line (`$ `, `#!/bin/bash`, a known CLI name like `openclaw`/`node scripts/…`/`db-query.js`).
2. For each non-comment line inside those blocks, flag the presence of:
   - **Rule 1b.1** — chain operators `&&`, `||`, or unquoted `;` joining two commands.
   - **Rule 1b.2** — stderr redirect `2>/dev/null` (or `2>&1`, `2>/dev/null` variants).
   - **Rule 1b.3** — command substitution via `` `…` `` or `$(…)` on a line that also executes something else. (A standalone `FOO=$(cmd)` assignment used alone inside a HEREDOC example is tolerated — judgement: if the preflight would reject it, flag it.)
3. Pipes (`|`) and here-docs (`<<EOF … EOF`) are **allowed**: they are not in CLAUDE.md's forbidden set. Do not flag them.
4. **Flag as CRITICAL** every hit. Include a suggested rewrite that splits the offending line into one command per fenced block.

Suggested-rewrite fenced blocks for CRITICAL findings must be copy-pasteable, e.g.:
```bash
cmd-a
```
```bash
cmd-b
```

### Pass 2 — Script references (mechanical)

**Why:** Same failure mode as Pass 1 but for scripts. A deleted or renamed script still referenced in instructions = runtime crash. An existing script not deployed to an agent = silent "command not found" when that agent tries it.

**As of P5, `cclaw` is the canonical command surface.** Script references must only appear for retained scripts (see Pass 1.5 whitelist). Any reference to a deleted script is CRITICAL.

1. List all `.js` and `.sh` files currently in `scripts/` (the retained set post-P5).
2. Grep every instruction file for `node scripts/<file>` and bare `scripts/<file>` references.
3. **Flag as CRITICAL** any reference to a non-existent script (i.e., a script deleted in P5 but still referenced in instructions).
4. Read `build-templates.sh` to determine which scripts each agent receives.
5. **Flag as WARNING** any retained script referenced in an agent's instructions that is NOT deployed to that agent.

### Pass 3 — Constant consistency (semi-mechanical)

**Why:** `libs/chain/src/portfolio-rules.ts` is the single source of truth for portfolio rules post-P5 (previously `scripts/chains.js`, which is retained in P5 only as a load-time import of `db-query.js`, not as the limit authority). If AGENTS.md says "max moonshot 6%" but `portfolio-rules.ts` enforces 5%, the code will reject proposals the markdown told the LLM to make. The LLM is the one who looks wrong.

1. Extract all numeric portfolio rule constants from `libs/chain/src/portfolio-rules.ts` (position limits, cash reserves, slippage limits, narrative caps). This is canonical post-P5. `scripts/chains.js` is retained in P5 as a db-query.js import dependency but `portfolio-rules.ts` is authoritative for limit values — do not use chains.js as the source for limit comparisons.
2. Extract numeric constants from instruction files — portfolio rule tables, safety rules, limit references.
3. **Flag as CRITICAL** any mismatch between markdown-stated values and `portfolio-rules.ts` values.
4. Regime adjustment tables often appear in multiple files. They must be byte-identical.
5. **Flag as WARNING** any regime-table discrepancy.

### Pass 3b — Heartbeat cadence alignment (mechanical)

**Why:** Three sources must agree on heartbeat timing. If they disagree, `get-overdue-checks` either silently ignores a check (perpetually skipped) or perpetually marks it overdue (cadence gate meaningless).

The three sources:
- `HEARTBEAT_CADENCES` object in `libs/modules/heartbeat/src/cadences.ts` (minutes per check per agent, used by the NestJS heartbeat service). `scripts/db-query.js` was deleted; cadences.ts is the canonical post-retained-deletion source.
- Cron `--every <interval>` values in `entrypoint.sh` (when the agent is actually invoked)
- Stated interval in each `agents/<agent>/HEARTBEAT.md` (what the LLM reads)

1. For each agent, extract the cron interval from `entrypoint.sh` (`add_if_missing` / `--every` lines). Compare to the stated interval at the top of `HEARTBEAT.md`. **Flag as WARNING** any mismatch.
2. For every key in `HEARTBEAT_CADENCES.<agent>`, verify its cadence ≥ cron interval. A cadence less than cron = always-overdue = meaningless gate. **Flag as WARNING** any violation.
3. Extract every `check_type` used in HEARTBEAT.md (e.g. `update-heartbeat --check <check_type>`, rotating-checks table names). Compare to the keys in `HEARTBEAT_CADENCES.<agent>`. **Flag as CRITICAL** any check_type in HEARTBEAT.md that is not a key in `HEARTBEAT_CADENCES` — `get-overdue-checks` silently ignores it. **Flag as INFO** any key in `HEARTBEAT_CADENCES` the agent's HEARTBEAT.md never references.
4. For each row in a HEARTBEAT.md cadence table with a human-readable cadence ("every 30 min"), verify the minutes match the `HEARTBEAT_CADENCES` entry. **Flag as WARNING** any mismatch.

### Pass 3c — CLAUDE.md drift (mechanical)

**Why:** CLAUDE.md is the project's single-page overview. Developers (and Claude) read it to understand the system. If it says "three agents" when there are four, or lists 18 DB tables when `db.js` migrations define 21, every future contributor starts from a wrong mental model.

1. Agent count and cadences — CLAUDE.md mentions four agents with specific heartbeat intervals. Verify each agent is represented in `entrypoint.sh` with the stated interval.
2. Script list — CLAUDE.md contains a "Project Structure" section listing scripts under `scripts/`. Verify every script listed exists; **flag as INFO** any script in `scripts/` that is not listed (CLAUDE.md doesn't have to be exhaustive, but conspicuous omissions are worth noting).
3. DB table count — CLAUDE.md names tables explicitly ("21 tables: positions, trades, …"). Cross-check against the model definitions in `prisma/schema.prisma` (canonical post-retained-deletion; `scripts/db.js` was deleted). **Flag as WARNING** on count or name mismatch.
4. Safety rule constants — CLAUDE.md duplicates the portfolio limits under "Safety Rules". Cross-check against `libs/chain/src/portfolio-rules.ts` (canonical post-P5) the same way as Pass 3. **Flag as CRITICAL** on mismatch.
5. Command lists in CLAUDE.md (e.g. database query examples) — validate the same way as Pass 1.

### Pass 4 — Cross-file behavioral consistency (semantic)

**Why:** Agents hand off via JSON payloads. If Sentinel writes an order with field `urgency` but Executor parses `priority`, the order silently fails validation. Same risk between AGENTS.md and SKILL.md within a single agent — they must describe the same behavior with the same parameters.

1. For each agent, compare `AGENTS.md` against its `skills/*/SKILL.md` files. Same behavior, same thresholds, same field names. **Flag as WARNING** any inconsistency.
2. Compare `HEARTBEAT.md` scan parameters (intervals, batch sizes, limits) against SKILL.md defaults.
3. Sell-order JSON — field names in Sentinel files must match what Executor parses.
4. Trade-proposal JSON — same between Research files and Executor files.
5. Paper mode command mapping — every agent that references paper mode should use the correct `paper_*` variant commands, not the real-mode versions.

### Pass 5 — Completeness (semantic)

**Why:** Unused documentation rots. Scripts deployed but never invoked are dead code; commands documented but not reachable by the agent confuse the LLM about its capabilities.

1. Every command in an agent's `TOOLS.md` should appear in at least one of that agent's instruction files (AGENTS.md, HEARTBEAT.md, SKILL.md). **Flag as INFO** any command documented but unreferenced. Also flag any TOOLS.md command for a script the agent doesn't have deployed.
2. Every script deployed to an agent should be referenced in at least one of its instruction files. **Flag as INFO** any deployed-but-unreferenced scripts.
3. Every safety rule in an agent's AGENTS.md should have a corresponding check or reference in at least one SKILL.md. **Flag as INFO** any rule lacking a skill-level touchpoint.

### Pass 6 — Structural hygiene (mostly mechanical)

**Why:** This pass catches the accretion pattern directly: edits made without restructuring the document. Each rule below corresponds to a signature a hurried editor leaves behind. Findings are STRUCTURE severity because the document still parses and the commands still exist — but an LLM reading it will trip on the disorganization.

Every STRUCTURE finding MUST include (a) the rule ID, (b) `file:line`, (c) a concrete suggested rewrite as a fenced block. Vague findings ("this section feels cluttered") are not acceptable.

**Rule 6.1 — Letter-suffixed numbered items.** Regex: `^\s*\d+[a-z]\.` (e.g. `3b.`) or `###\s*\d+[a-z]\.`. This pattern is almost always a late insertion. Suggested fix: either renumber to integer sequence (shift following items up) or promote to a clearly-titled subsection with a "When: <condition>" line explaining why it's a sibling.

**Rule 6.2 — Numbering gaps or duplicates.** Extract each numbered list; verify it is contiguous starting from 1. Gap example: `1, 2, 4`. Duplicate example: `1, 2, 2, 3`. Either signals a botched edit.

**Rule 6.3 — Broken or fragile cross-references.** Find patterns like `see step N`, `see above`, `see below`, `§ <heading>`, `as noted earlier`, `(See AGENTS.md § X)`. Verify each target exists **and is reachable in the same lifecycle phase as the referring file**. A reference that resolves at audit time but not at runtime is the worst kind — it silently drops whichever rule it points to.

Grade each reference by the lifecycle relationship between the file containing the reference (the "from" file) and the file containing the target (the "to" file):

| From → To | Severity | Rule | Why |
|---|---|---|---|
| Same file | INFO if >500 lines away, else OK | 6.3.a | In-context; only fragile if distant |
| any → `AGENTS.md` / `SOUL.md` / `CLAUDE.md` | INFO | 6.3.a | Always resident in the bootstrap layer |
| any → `TOOLS.md` | INFO | 6.3.a | Reference material, consulted on demand |
| `HEARTBEAT.md` → `SKILL.md` | **WARNING** | 6.3.b | Skill only loads when that step invokes it; risky if control flow branches before the invocation |
| `SKILL.md` → sibling `SKILL.md` | **CRITICAL** | 6.3.b | Siblings are never co-resident — the reference is unreachable whenever this skill runs |
| `SKILL.md` → `HEARTBEAT.md` | **WARNING** | 6.3.b | Heartbeat is not loaded during a skill invocation |
| Missing target (any direction) | **CRITICAL** | 6.3.c | LLM cannot resolve the reference at all |

Every 6.3.b and 6.3.c finding must propose a concrete fix: either inline the referenced rule into the referring file, or promote the shared rule into `AGENTS.md` (which is always resident) so both sides can refer to it safely.

**Rule 6.4 — Heading level jumps.** Walk the heading sequence. Flag skips (`h1 → h3` without an `h2`) and deep nesting (`h5` or deeper) in procedural docs — these signal structural dilation without refactor.

**Rule 6.5 — Accretion residue.** Flag:
- HTML comments like `<!-- TODO -->`, `<!-- FIXME -->`, `<!-- OLD -->` in committed instruction files.
- Multiple `> **Note on X** — …` blockquote asides in the same file (one is useful; three is usually patch-on-patch).
- Parenthetical edit-history artefacts: `(was: X, now: Y)`, `(previously…)`, `(new — added YYYY-MM-DD)`.

### Pass 7 — Terminology consistency (mechanical)

**Why:** LLMs bind behavior to names. When the same concept appears as `smart_money` (DB column), `smart-money` (prose adjective), and `smart money` (bare phrase), the model may treat them as three different things, or apply rules about one to another by accident.

**Rule 7.1 — Concept spelling variants.** Build a fly-by glossary from the corpus. Flag when a single concept appears with >1 spelling in prose. Ignore identifiers inside backticks or JSON blocks — those are legitimately the code's spelling. The check is specifically for prose drift.

Candidates to watch: `smart money` / `smart-money`; `stop-loss` / `stoploss`; `take-profit` / `take profit`; `paper mode` / `paper-mode`; `rug warning` / `rug_warning` (outside JSON); `multi-chain` / `multichain`. Severity: STRUCTURE.

**Rule 7.2 — Command-reference variants.** Within a single file, pick the dominant form of how commands are invoked (e.g. `cclaw <resource> <action>` inside fenced blocks, bare `cclaw resource action` in inline prose). Flag deviations from the file's dominant form. Post-P5b, the dominant form in all agent markdown is `cclaw <resource> <action>` — any `node scripts/db-query.js` form is a CRITICAL deviation. This is a consistency rule, not a global rule — different files can legitimately pick different dominant forms.

**Rule 7.3 — Undefined acronyms.** ALL_CAPS terms (`TP`, `LP`, `PnL`, `DCA`, `TVL`, `LUT`) that appear without prior expansion in the same file. Severity: INFO. The LLM usually infers from context but it's cheap hygiene.

### Pass 8 — Duplication & contradiction (semi-mechanical)

**Why:** Duplicates drift. Two statements of the same rule will eventually disagree after an edit. Contradictions directly mislead the LLM — it will follow whichever rule its attention lands on first.

**Rule 8.1 — Near-duplicate rules across files.** Extract imperative sentences (starting with "You must", "Always", "Never", "Only", "Do not"). Cluster near-duplicates across files.
- Duplicates with different wording → **WARNING** (drift risk; the wording delta may hide a semantic delta).
- Duplicates that are bit-identical and could be consolidated to a shared file → **INFO**.

Some duplication is intentional — a safety rule may appear in both Research AGENTS.md (don't propose this) and Executor AGENTS.md (don't execute this). Use Pass 0 context to distinguish defense-in-depth duplication from drift.

**Rule 8.2 — Direct contradictions.** Pairs like `Always X` / `Never X`, or `Only X` / `Also Y` where X and Y are exclusive, with identical or overlapping conditions. Flag as **CRITICAL**. Quote both statements with `file:line` for each.

**Rule 8.3 — Under-specified conditionals.** Rules of form "If <X>, do <Y>" where X is vague: `if appropriate`, `if safe`, `as needed`, `when reasonable`. These outsource judgment to the LLM at exactly the wrong time. Flag as STRUCTURE with a suggested rewrite specifying the condition.

### Pass 9 — Section balance (diagnostic, INFO only)

**Why:** A section 3× longer than its siblings usually means accretion without refactor. This is a low-urgency diagnostic — most flags here won't need immediate action, but they point at where the next structural refactor should focus.

**Rule 9.1 — Outlier section length.** For each file, compute the line count of each `h2` (and each `h3` within a given `h2`). Flag sections >3× the median of their siblings. Severity: INFO.

**Rule 9.2 — Long numbered lists.** Numbered lists with >10 items often benefit from subgrouping by concern. Severity: INFO.

### Pass 10 — Bootstrap budget (mechanical)

**Why:** Every session starts — and every post-compaction rehydration restarts — by loading the *resident* layer into context: `SOUL.md + AGENTS.md + USER.md + MEMORY.md + IDENTITY.md` (whichever exist). If this set exceeds the configured `reserveTokensFloor`, compaction cannot keep the bootstrap intact, and the agent loses identity, safety rules, or cross-session state. The symptom on the operator side looks like hallucination or "the agent forgot what we agreed yesterday" — but the root cause is a budget breach visible only by summing file sizes against the live config.

**Source of truth:** `entrypoint.sh` is the sole configuration surface. OpenClaw is configured entirely via `openclaw config set` CLI calls there — **there is no `openclaw.json` file in this project** and the audit must not look for one.

1. Extract budget values from `entrypoint.sh`:
   - Default `reserveTokensFloor` — match `openclaw config set 'agents.defaults.compaction.reserveTokensFloor' <N>`.
   - Default `memoryFlush.softThresholdTokens` — match either the explicit `…memoryFlush.softThresholdTokens` key or the inline JSON form on the `…memoryFlush '{…,"softThresholdTokens":N,…}'` line.
   - Per-agent overrides — match `openclaw config set 'agents.list[<idx>].compaction.reserveTokensFloor' <N>` and the analogous `memoryFlush` override. If the same key is set more than once in execution order, the **last write wins**.
   - Map `agents.list[idx]` → agent name by walking the `openclaw agents add <name>` calls earlier in `entrypoint.sh` in order (index 0 = first `agents add`, etc.).
2. For each agent, enumerate its resident bootstrap set — include only files that physically exist in the agent's directory: `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`, `IDENTITY.md`.
3. Estimate token cost with the heuristic `tokens ≈ chars / 4`. This is deliberately approximate — the pass flags obvious breaches, not rounding-error proximity. Document the heuristic in every Pass 10 finding so the number is reproducible.
4. Compare sum vs that agent's effective `reserveTokensFloor`:

**Rule 10.1 — Bootstrap vs reserve.**
- Sum ≥ 100% of floor → **CRITICAL**. Compaction will evict bootstrap tokens → identity/rule loss.
- Sum 80–99% of floor → **WARNING**. One more edit to MEMORY.md or AGENTS.md will breach.
- Sum < 80% → no finding.

**Rule 10.2 — MEMORY.md soft cap.** `MEMORY.md` is the cross-session cheat sheet and is bounded by both `softThresholdTokens` (triggers a flush write) and the project convention "≤ 100 lines". Flag either breach:
- `MEMORY.md` > `softThresholdTokens` → **WARNING** (flush will fire on every session — noisy but not broken).
- `MEMORY.md` > ~100 lines → **WARNING** (convention breach; signals that daily-log content leaked into the cheat sheet).

**Rule 10.3 — Ambiguous agent index.** If `entrypoint.sh` contains per-agent `agents.list[N].compaction.…` overrides but the `openclaw agents add` ordering is interleaved with other commands such that the index-to-name mapping is not unambiguous from a single top-to-bottom read → **WARNING**. A reorder of the `agents add` block would silently retarget every override.

Every Pass 10 finding must cite the extracted budget values with `entrypoint.sh:line` for traceability.

### Pass 11 — Rule placement by lifecycle layer (semantic)

**Why:** Instructions don't all live in context at the same time. `AGENTS.md` and `SOUL.md` are *always resident* (bootstrap). `HEARTBEAT.md` is loaded *only when cron fires* the agent. `SKILL.md` is *lazy-loaded* only when that skill is invoked. `TOOLS.md` is reference material consulted on demand. An unconditional safety rule — "Never propose honeypots" — placed only in a `SKILL.md` is invisible to the agent whenever that skill is not running. The rule exists on disk but is effectively deleted at every other moment. This is how silent safety breaches happen.

Pass 11 is the hardest pass in this skill: classification of rule scope is semantic, not mechanical. Findings carry more uncertainty than other passes — the discipline that keeps it honest is (a) quoting the rule verbatim, (b) citing its current location, and (c) proposing a concrete target file.

1. Extract imperative sentences across all agent files: sentences starting with "You must", "Always", "Never", "Only", "Do not", "Refuse to", "Reject", or "Block".
2. Classify the scope of each rule by reading its text:
   - **Unconditional** — no temporal or situational qualifier. Examples: "Never propose honeypots", "Always enforce slippage caps", "Refuse to log private keys." Correct home: `AGENTS.md` (operating contract) or `SOUL.md` (identity-level boundary).
   - **Heartbeat-scoped** — scope is the current heartbeat cycle. Keywords: "this cycle", "at every heartbeat", "when cron fires", "per check". Correct home: `HEARTBEAT.md`.
   - **Skill-scoped** — scope is the act of performing one skill. Keywords: "when proposing trades", "during risk analysis", "while triaging", matching the skill's own domain. Correct home: that skill's `SKILL.md`.
3. Flag mismatches between observed scope and current placement.

**Rule 11.1 — Unconditional rule outside the resident layer.** An unconditional rule found only in `HEARTBEAT.md` or `SKILL.md` → **CRITICAL**. The rule is invisible outside that phase. Suggested fix: move the rule to the agent's `AGENTS.md` (or `SOUL.md` if it's an identity-level rule), and leave a brief pointer in the original location if the phase-specific context needs the reminder.

**Rule 11.2 — Heartbeat-scoped rule promoted to bootstrap.** A rule that only applies during a heartbeat cycle but lives in `AGENTS.md` → **STRUCTURE**. Not dangerous, but consumes bootstrap budget (see Pass 10) and can confuse the LLM about when to apply it. Suggested fix: move to `HEARTBEAT.md`.

**Rule 11.3 — Skill-scoped rule leaked to sibling skill or bootstrap.** A rule whose scope is clearly one skill's domain but appears in a sibling skill's `SKILL.md`, or is duplicated in `AGENTS.md` in a form that binds it to the specific skill — **STRUCTURE**. Suggested fix: consolidate in the correct skill; if both skills legitimately need it, promote to `AGENTS.md` in a scope-neutral wording.

Pass 11 accepts higher false-positive rates than mechanical passes. Every finding must quote the rule, cite `file:line`, and propose a target file — never flag on vibe.

### Pass 12 — Persist-before-compact contract (mechanical)

**Why:** OpenClaw compaction is lossy by design — anything not written to a file before compaction is gone. The persistence hooks that protect continuity are:
- `memory/YYYY-MM-DD.md` — daily working log (written by the agent during its heartbeat)
- `MEMORY.md` — promoted long-term patterns (written when a pattern is observed 3+ times)
- `cclaw logs <agent> append` — structured per-agent event log (research_log, sentinel_log, executor_log, observer_log)

If an agent's `HEARTBEAT.md` never instructs a persist step, every lesson the agent learns within a cycle is discarded at the next compaction. The agent appears to perpetually re-discover the same patterns — on the operator side this reads as amnesia or confabulation. If a finding-producing `SKILL.md` has no promotion clause, useful patterns stay buried in daily logs forever.

**Rule 12.1 — Heartbeat persist step.** For each agent's `HEARTBEAT.md`, grep for at least one of:
- `memory/YYYY-MM-DD.md`, `memory/$(date`, `append … memory`, `daily log`, `write … memory`
- `cclaw logs research append`, `cclaw logs sentinel append`, `cclaw logs executor append`, `cclaw logs observer append`
- Explicit `MEMORY.md` update instruction tied to cycle-end.

If no match → **CRITICAL**. Quote the heartbeat's final step(s) and propose a rewrite that appends findings to the daily log or the appropriate `*_log` table before the heartbeat exits.

**Rule 12.2 — Skill promotion clause.** For each `SKILL.md` in the finding-producing allowlist (`research/skills/discovery`, `research/skills/analyst`, `research/skills/risk`, `research/skills/portfolio`, `sentinel/skills/sentinel`, `observer/skills/triage`), grep for a promotion clause:
- "when pattern seen 3+ times, add to MEMORY.md" (or equivalent numeric threshold)
- Explicit reference to `MEMORY.md` as the target for long-term patterns.

If no match → **WARNING**. Suggested rewrite: add a short "Promotion" subsection describing when a recurring finding from this skill should graduate from the daily log to `MEMORY.md`.

Pass 12 is mechanical and should be run even when the skill's prose looks complete — the absence of the persist hook is easy to miss on casual reading.

## Output format

Produce the report in exactly this format:

```
## Instruction Audit Report — YYYY-MM-DD

### CRITICAL (would break agent behavior)
- [file:line] (rule ID if applicable) description + suggested fix

### STRUCTURE (would mislead an LLM)
- [file:line] (rule ID) description + suggested rewrite as a fenced block

### WARNING (inconsistency, unclear intent)
- [file:line] description + question about which value is correct

### INFO (completeness, style)
- description

### Summary
- X CRITICAL, Y STRUCTURE, Z WARNING, W INFO
- Files audited: N | Commands checked: N | Scripts checked: N
- Top structural hotspots: <file> (N findings), <file> (N findings)

### Appendix — findings beyond top 10 per category
(Categories that exceeded 10 findings in the main body spill here, same format.)
```

Each main-body section shows at most **10 findings**, ranked by likelihood of causing wrong LLM behavior. Everything beyond that lands in the Appendix, same format. Rank CRITICAL by blast radius (how many agent behaviors fail), STRUCTURE by reader-impact (how likely an LLM is to misread), WARNING by uncertainty cost, INFO by age/scope.

If a section has no findings, include it with "None found."

## Operational rules

- **Read-only.** Never modify any files — this is audit, not cleanup. A follow-up skill or manual edit applies the rewrites.
- **Rule IDs required on STRUCTURE findings.** Every STRUCTURE finding cites its rule (6.1, 7.2, etc.). This keeps the pass disciplined and prevents vibe-based flagging.
- **Concrete rewrites required on STRUCTURE findings.** Each must include a suggested rewrite as a fenced block. The operator should be able to copy-paste the fix.
- **Line numbers on everything.** Never say "somewhere in AGENTS.md" — always `file:line`.
- **CRITICAL always ships a fix.** If you flag CRITICAL but cannot suggest the correct value (e.g. you don't know the canonical one), say so explicitly and demote to WARNING with a question for the operator.
- **Pass 0 grounding is mandatory.** Don't skip reading CLAUDE.md and `entrypoint.sh` even if you feel you already know the project.
- **Run passes in order.** Earlier passes establish facts (command list, cadence map, budget values) that later passes rely on.
- **Token estimates are heuristic.** Pass 10 uses `tokens ≈ chars / 4` — quote it to 2 significant figures at most, and always cite the line-count and char-count alongside the estimate so findings are reproducible.

## What this skill does NOT do

- It does not modify files. Not even to fix obvious typos.
- It does not run tests, execute scripts, or query the database.
- It does not audit `workspace/TOOLS.md` (the dev-only full reference) — only the per-agent `TOOLS.md` files that ship to agents.
- It does not audit the daily memory logs under `agents/<agent>/memory/YYYY-MM-DD.md` — those are runtime-generated, not instruction files. Pass 12 checks that the heartbeat *writes to them*, not their contents.
- It does not compute true tokenizer counts. Pass 10's budget math is deliberately approximate and should be read as "clearly within / clearly over / borderline", never as a precise measurement.
- It does not audit `openclaw.json` — that file does not exist in this project. All OpenClaw runtime config is applied via `openclaw config set` calls in `entrypoint.sh`.
- It does not audit git history or recent diffs. If that kind of pass is added later it will be a separate Pass 13.
- It does not rank files by "overall health score" — findings are the output, not a grade.
