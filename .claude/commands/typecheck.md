---
description: Run pnpm typecheck and summarize errors by file.
---

Run TypeScript type checking:

```bash
pnpm typecheck
```

After the run:

1. **Exit 0** — print `✓ typecheck passed` and stop.

2. **Errors** — parse the `tsc` output and group by file. Print:

   ```
   <file_path> — <N> error(s)
     <line:col> — <error code> — <short message>
     <line:col> — <error code> — <short message>
   ```

3. For obvious causes (missing import, wrong type, narrowing issue), suggest the smallest fix in one sentence per error. **Do not apply fixes** — the `coder` agent owns code changes.

4. End with a summary: `<total> errors across <N> files`.

Stop after the report. The next step is to invoke the `coder` agent against the specific errors, not to start patching mid-report.

Note: during P-prep / P0, `pnpm typecheck` may not yet be wired up. If the script is missing, print: `pnpm script "typecheck" not yet defined — current phase is P-prep / P0; tsc wiring lands in P0 (see SPEC §15, §16).` and stop.
