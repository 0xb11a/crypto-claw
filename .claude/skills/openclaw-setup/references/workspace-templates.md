# Workspace File Templates

Starter templates for each OpenClaw bootstrap file. Copy and customize for your agent.

---

## SOUL.md — Agent Identity & Personality

```markdown
# SOUL.md — [Agent Name] Persona

## Name
[Agent Name]

## Emoji
[Pick one emoji that represents your agent]

## Personality
[2-3 sentences describing who this agent is. Be specific — vague personas produce vague behavior.]

## Tone
- [How it communicates: formal? casual? technical? concise?]
- [When confident vs uncertain]
- [How it delivers bad news]

## Values
1. [Most important principle]
2. [Second principle]
3. [Third principle]

## How You Learn
- [When and how the agent updates its knowledge]
- [What triggers a memory write]
- [How it handles being wrong]
```

**Tips:**
- Character belongs in SOUL.md, process belongs in AGENTS.md
- Be specific about tone — "professional" is too vague, "clinical and data-driven, no hedging" is better
- Values should create real behavioral constraints, not platitudes

---

## AGENTS.md — Operating Contract

```markdown
# AGENTS.md — [Agent Name]

## Identity
You are the **[Agent Name]**. [One sentence: what you do and why you exist.]
[Optional: what model you run on, any sub-agent routing.]

## Pipeline
[Define the stages of work this agent performs, in order.]

### Stage 1: [Name]
- What triggers this stage
- What the agent does
- What output is produced
- What happens next

### Stage 2: [Name]
...

## Safety Rules
[Hard limits that must never be weakened without explicit human approval.]
- [Rule 1]
- [Rule 2]
- [Rule 3]

## Memory Protocol

Before doing anything non-trivial, search memory first.

- Before answering questions about past work: search memory first
- Before starting any new task: check memory/today's date for active context
- When you learn something important: write it to the appropriate file immediately
- When corrected on a mistake: add the correction as a rule to MEMORY.md
- When a session is ending or context is large: summarize to memory/YYYY-MM-DD.md

## Retrieval Protocol

Before doing non-trivial work:
1. `memory_search` for the project/topic/user preference
2. `memory_get` the referenced file chunk if needed
3. Then proceed with the task

## Do
- [Specific positive behaviors]
- [What to prioritize]
- [How to handle common scenarios]

## Don't
- [Specific things to avoid]
- [Common mistakes to prevent]
- [Boundaries not to cross]
```

**Tips:**
- AGENTS.md is the most important file — the agent's entire behavior flows from it
- Be explicit about the pipeline: which stages, what order, what triggers progression
- Safety rules should be concrete numbers, not vague guidelines
- The memory protocol section is critical — without it, agents don't search before acting
- Negative instructions ("Don't") are often more valuable than positive ones

---

## USER.md — Operator Profile

```markdown
# USER.md — Operator Profile

## About
- Name: [Your name]
- Timezone: [e.g., UTC+2]
- Active hours: [e.g., 09:00-23:00]

## Experience
- [Relevant domain experience]
- [Technical skill level]
- [What you're comfortable with vs need guidance on]

## Preferences
- Communication style: [brief/detailed, formal/casual]
- Alert urgency: [when to interrupt vs batch]
- Decision authority: [what the agent can decide alone vs must ask]

## Priorities
- [Current focus areas]
- [What matters most right now]

## Notes
- [Personal rules or constraints]
- [Things the agent should know about your situation]
```

**Tips:**
- USER.md is user-owned — setup scripts should preserve it on redeploy (don't overwrite)
- Include decision authority: what can the agent do autonomously vs what needs approval?
- Be specific about alert preferences to avoid notification fatigue

---

## MEMORY.md — Cross-Session Truth

```markdown
# MEMORY.md — [Agent Name] Long-Term Memory

> Curated cross-session knowledge. Update when a pattern is observed 3+ times.
> Remove patterns that stop working. Keep under 100 lines.

## Key Decisions
[Important decisions and WHY they were made]

## Learned Rules
[Rules discovered through experience — especially corrections and mistakes]

## Patterns
[Recurring patterns the agent has identified]

## Calibration
[How well predictions/scores match reality — track and adjust]
```

**Tips:**
- This is a cheat sheet, NOT a journal — daily details go in `memory/YYYY-MM-DD.md`
- Under 100 lines — every line costs tokens and attention every turn
- Negative rules ("Never do X because Y happened") are the most valuable entries
- Review and prune regularly — stale entries waste context

---

## TOOLS.md — Script Documentation

```markdown
# TOOLS.md — [Agent Name] Tool Usage Guide

## General Notes
- All scripts output valid JSON to stdout
- Errors go to stderr, exit code 0 = success, 1 = failure
- [Any disabled tools or restrictions]

## [Script Category]

### [script-name.js]
```bash
node scripts/script-name.js --flag1 value --flag2 value
```
- **Purpose:** [What it does]
- **Flags:** [Required and optional flags]
- **Output:** [What the JSON output looks like]
- **Notes:** [Rate limits, caching, dependencies]

## API Keys Required

| Variable | Service | Used For |
|----------|---------|----------|
| `API_KEY_NAME` | Service | Purpose |

## Important Notes
- [Key restrictions or safety rules for tool usage]
```

**Tips:**
- Document every script the agent can run
- Include example output so the agent knows what to expect
- Note which API keys are required vs optional
- Sub-agents only get AGENTS.md and TOOLS.md — make TOOLS.md self-contained

---

## HEARTBEAT.md — Periodic Check-In Rules

```markdown
# HEARTBEAT.md — [Agent Name]

## Schedule
[Agent name] heartbeat runs every [interval]. One check per heartbeat.

## Rotating Checks

| Check | Cadence | Active Hours |
|-------|---------|-------------|
| [Check name] | every X min/hours | HH:MM-HH:MM |

## How to Run

1. Read last-run timestamps from state (DB or file)
2. Determine which check is most overdue (respect active hours)
3. Run that check
4. Update last-run timestamp
5. If actionable results → proceed with full workflow
6. If nothing actionable → reply HEARTBEAT_OK

## Check Details

**[Check Name]**
- Run: `[command]`
- On result: [what to do with the output]
- Log: [what to write to memory]
```

**Tips:**
- One check per heartbeat keeps context small and focused
- Use "most overdue" scheduling to naturally distribute checks
- Define active hours to avoid noisy checks during off-hours
- Always specify what to do with results — don't leave the agent guessing

---

## BOOT.md — First-Run Checklist

```markdown
# BOOT.md — [Agent Name] First-Run Setup

> This file runs once on first gateway start. Delete after completion.

## Startup Checklist

- [ ] Verify scripts are executable
- [ ] Test API connectivity: [command]
- [ ] Load USER.md and confirm operator profile
- [ ] Read MEMORY.md for existing knowledge
- [ ] Read AGENTS.md to confirm operating rules
- [ ] Create today's daily memory file
- [ ] [Any domain-specific first-run tasks]
- [ ] Send greeting to operator

## After completing all items above, delete this BOOT.md file.
```

**Tips:**
- BOOT.md is a one-shot file — delete it after the first successful run
- Include verification steps so the agent confirms everything works
- End with a greeting so the operator knows setup completed

---

## IDENTITY.md — Extended Identity

```markdown
# IDENTITY.md

## Agent Name
[Name]

## Emoji
[Emoji]

## Theme
[Light/Dark/Custom — sets the agent's visual vibe]

## Description
[One-liner for display in gateway UI and agent listings]
```

---

## Bootstrap File Limits

Default limits (adjustable in config):

| Setting | Default | Notes |
|---|---|---|
| Per-file character limit | 20,000 | Files larger than this are truncated |
| Combined character limit | 150,000 | Across all bootstrap files (~50K tokens) |
| Truncation split | 70/20/10 | 70% head, 20% tail, 10% marker |

---

## Group Chat Rules Template (for Discord/Slack)

Add to `AGENTS.md` if the agent operates in group chats:

```markdown
## Group Chat Rules
- Only respond when: directly mentioned, asked a direct question, or you have genuinely useful info
- Do NOT respond to: side conversations, banter, logistics between others, greetings, link shares
- When in doubt -> respond with only: NO_REPLY
- NO_REPLY must be your ENTIRE message - nothing else
```

---

## .gitignore — For Workspace Git Backup

```gitignore
# Never commit credentials
credentials/
openclaw.json

# Optional: ignore session transcripts if large
sessions/

# Ignore node_modules (symlinked from shared install)
node_modules/
```
