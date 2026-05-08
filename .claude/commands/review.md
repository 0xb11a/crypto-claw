---
description: Run the reviewer subagent on the current branch's diff against the base branch; produce a structured verdict.
argument-hint: "[base branch — defaults to main]"
---

Invoke the `reviewer` subagent for a code review of the current branch.

Base branch: `${ARGUMENTS:-main}`.

1. Use the Agent tool to spawn the `reviewer` subagent with this prompt:

   > Review the current branch (`HEAD`) against `${ARGUMENTS:-main}`. Run the verification gates: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm coverage`. For DoD §C changes also run `pnpm run build:openapi` and `pnpm run build:sdk` and assert `git diff --exit-code` is clean. For DoD §D changes run `pnpm prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --exit-code`. Read every `SPEC.md` and `docs/dod.md` section affected by the diff. Read the diff in full — don't trust the summary. Apply the priorities in your agent definition (`.claude/agents/reviewer.md`): SPEC alignment first, invariants (§4), DoD compliance, test adequacy (§14), logging/observability (§11), security (§9), operational impact. Produce the structured verdict block exactly as specified in your agent definition.

2. When the reviewer returns, present the verdict block **verbatim**. Do not soften or amplify the language. Do not start fixing blockers in this turn — that's a separate cycle through the `coder` agent.

3. If the verdict is `REQUEST_CHANGES` or `BLOCK`, print the blockers as a numbered to-do list at the end.
