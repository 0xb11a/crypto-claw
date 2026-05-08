---
description: Run the audit-instructions skill via the instruction-auditor subagent; surface drift findings as a numbered to-do list.
---

Run a full-corpus audit of the OpenClaw runtime agent surfaces — `agents/{research,sentinel,executor,observer}/AGENTS.md|SOUL.md|HEARTBEAT.md|TOOLS.md`, their `skills/*/SKILL.md`, and the deployable workspace files — for referential, cross-file, structural, and prose-integrity drift.

Use the **Agent tool** to spawn the `instruction-auditor` subagent with this prompt:

> Audit the OpenClaw runtime agent instruction files in this repo. Follow `.claude/agents/instruction-auditor.md` strictly. Invoke the `audit-instructions` skill via the Skill tool, capture its full output, and produce the structured drift report exactly as specified in your agent definition. Cover: `agents/research/`, `agents/sentinel/`, `agents/executor/`, `agents/observer/` (AGENTS.md, SOUL.md, HEARTBEAT.md, TOOLS.md), each agent's `skills/*/SKILL.md`, and the deployable workspace files (`workspace/IDENTITY.md`, `workspace/BOOT.md`, `workspace/USER.md`, `workspace/TOOLS.md`). Cross-reference against `scripts/`, `apps/`, `libs/` (where they exist), `entrypoint.sh`, `build-templates.sh`, `SPEC.md`, `docs/dod.md`, and `CLAUDE.md`.

When the auditor returns:

1. Present the **Drift report** block **verbatim**. Do not soften or amplify the language.

2. If the verdict is `DRIFT` or `BLOCKING`, print the blockers as a numbered to-do list at the end.

3. If the verdict is `BLOCKING`, recommend the operator invoke `/run-pipeline` against a coder fix (or fix manually if the change is one-line).

4. Reminder: DoD §H requires a clean audit before merge for any PR that touched agent surfaces.

Note: this command is the second gate for DoD §H. The first gate is the pre-commit hook in `.claude/settings.json`. Both run independently; clean both before merge.
