---
description: Run the coder → tester → reviewer pipeline end-to-end against the plan currently on the table. Skips the planner; assumes a plan was just produced and approved in this conversation.
argument-hint: "[plan reference — defaults to 'the plan immediately above']"
---

Execute the implementation pipeline against the plan referenced by `${ARGUMENTS:-the plan immediately above this message}`.

Run the following sequence. **Do not pause for user input between steps unless an agent reports a failure or surfaces a design question.** Hand off automatically.

## Step 1 — Coder

Use the **Agent tool** to spawn the `coder` subagent with this prompt:

> Implement the approved plan referenced as: `${ARGUMENTS:-the plan immediately above this message}`. Follow `.claude/agents/coder.md` strictly — produce TypeScript that compiles cleanly under strict mode (`pnpm typecheck`), lints clean (`pnpm lint`), respects SPEC §4 invariants, satisfies the applicable DoD kinds (A–J) listed in the plan, and updates DTOs / `class-validator` decorators / Prisma schema as needed. For DoD §C changes, regenerate `sdk/generated/openapi.json` and `sdk/generated/` and commit the deltas. For DoD §D changes, generate a Prisma migration via `pnpm prisma migrate dev --name <descriptive>`. Update `SPEC.md` if you deviate. End with the "Handoff to tester" block exactly as specified in your agent definition.

Capture the coder's full output, including the **Handoff to tester** block.

If the coder reports a hard failure (compile error, missing dependency, blocking unknown), **stop the pipeline** and report the failure. Do not proceed to Step 2.

If the coder flags an ADR follow-up in the handoff, surface that to the operator at the end of this run; **do not invoke `adr-writer` automatically** — that's an explicit operator step.

## Step 2 — Tester

Use the **Agent tool** to spawn the `tester` subagent with this prompt:

> Tests for the changes the coder just produced. The coder's "Handoff to tester" block is:
>
> ```
> <paste the coder's full Handoff to tester block here verbatim>
> ```
>
> Follow `.claude/agents/tester.md` strictly. Verify SPEC §14 coverage thresholds (≥ 80% line on `libs/modules/*`). Run `pnpm test` and `pnpm coverage`. Do NOT mock the audit log, the signer-key spawn helper in `libs/execution`, the Prisma migration runner, or the `libs/logger` redactor. For BullMQ processors, assert idempotency (running twice over the same input leaves the DB unchanged). End with the "Handoff to reviewer" block.

Capture the tester's output.

If the tester reports failures (test failures, coverage below threshold, untestable behavior), **stop the pipeline**. Report what the tester found and recommend the next step (usually re-engage the coder for fixes). Do not proceed to Step 3.

## Step 3 — Reviewer

Use the **Agent tool** to spawn the `reviewer` subagent with this prompt:

> Review the current branch (`HEAD`) against `main`. The coder produced the changes; the tester verified them. The tester's "Handoff to reviewer" block is:
>
> ```
> <paste tester's full Handoff to reviewer block here verbatim>
> ```
>
> Follow `.claude/agents/reviewer.md` strictly. Run the verification gates (`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm coverage`). For DoD §C run the OpenAPI/SDK drift gates. For DoD §D run `pnpm prisma migrate diff … --exit-code`. Read the affected `SPEC.md` and `docs/dod.md` sections. Read the diff in full — do not trust the summary. Apply your priority order (SPEC alignment, §4 invariants, DoD compliance, tests §14, logging §11, security §9, operational impact). Produce the structured verdict block exactly as specified.

Capture the reviewer's verdict.

## Step 4 — Surface the result

Present the reviewer's verdict block **verbatim** to the user. Then add one paragraph of recommendation:

- **APPROVE** or **APPROVE_WITH_NITS** → suggest a Conventional Commits commit message based on the changes; scope should match a SPEC §6 / §7 module name (e.g., `feat(orders): add POST /v1/orders/:id/approve per §7`). Mention any nits to follow up in a separate change. If the coder flagged an ADR follow-up, remind the operator to invoke `adr-writer` separately before the commit.
- **REQUEST_CHANGES** → list the blockers as a numbered to-do list. Stop. Do NOT start fixing them; that's the next cycle through the coder.
- **BLOCK** → list blockers AND surface them for SPEC-level review. Stop.

Do not commit the work yourself — the user retains the final commit decision.

## Pipeline-wide rules

- **Pass plan context, not just instruction.** The coder needs to understand what's being built, not just a one-line task. The plan reference (`${ARGUMENTS}`) tells it where to look.
- **Carry handoff blocks verbatim.** The handoff blocks are the contract between agents; paraphrasing loses information.
- **Stop on failure, never silently retry.** If any step fails, the operator decides the next move.
- **Do not invoke the planner** from this command. The planner is an explicit-only step; if a re-plan is needed, the operator calls it manually.
- **Do not invoke the researcher** preemptively. If the coder needs research, it asks for it via its own delegation; you don't pre-research here.
- **Do not invoke `adr-writer`** from this pipeline. ADRs are operator-decided.
- **Do not invoke `instruction-auditor`** from this pipeline. If the change touched OpenClaw runtime agent surfaces (`agents/{research,sentinel,executor,observer}/**`), the operator runs `/audit` separately before merge (DoD §H).
- **One pipeline per invocation.** This command runs the chain once. If the reviewer requests changes, the operator decides whether to re-run after fixes.
