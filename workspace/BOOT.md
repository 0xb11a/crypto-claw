# BOOT.md — CryptoClaw First-Run Setup

> This file runs once on first gateway start. Delete after completion.

## Startup Checklist

- [ ] Test API connectivity: `node scripts/market-overview.js`
- [ ] Load USER.md and confirm operator profile is filled in
- [ ] Read MEMORY.md to load any existing knowledge
- [ ] Read AGENTS.md to confirm operating rules
- [ ] Create today's daily memory file: `memory/YYYY-MM-DD.md`
- [ ] Run initial portfolio scan: `node scripts/portfolio-summary.js`
- [ ] Send greeting to operator: `node scripts/send-alert.js --type recovered --agent research --message "CryptoClaw is online. Ready to hunt."`

## After completing all items above, delete this BOOT.md file.
