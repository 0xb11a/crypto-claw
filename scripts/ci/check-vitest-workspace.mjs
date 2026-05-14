#!/usr/bin/env node
// check-vitest-workspace.mjs
//
// Guards that every libs/modules/<name>/vitest.config.ts path appears in
// vitest.workspace.ts. Exits 0 on success; exits 1 with a descriptive
// error if any module config is missing.
//
// Usage:
//   node scripts/ci/check-vitest-workspace.mjs
//
// Run before unit tests in CI (Category F.9 — P2 cleanup).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MODULES_DIR = join(REPO_ROOT, 'libs', 'modules');
const WORKSPACE_FILE = join(REPO_ROOT, 'vitest.workspace.ts');

// Read vitest.workspace.ts as raw text (not executed)
const workspaceContent = readFileSync(WORKSPACE_FILE, 'utf8');

// Discover all libs/modules/<name>/vitest.config.ts paths
const moduleNames = readdirSync(MODULES_DIR).filter((name) => {
  const dir = join(MODULES_DIR, name);
  if (!statSync(dir).isDirectory()) return false;
  try {
    statSync(join(dir, 'vitest.config.ts'));
    return true;
  } catch {
    return false;
  }
});

const missing = [];

for (const name of moduleNames) {
  const expectedPath = `libs/modules/${name}/vitest.config.ts`;
  if (!workspaceContent.includes(expectedPath)) {
    missing.push(expectedPath);
  }
}

if (missing.length > 0) {
  console.error(
    '[check-vitest-workspace] ERROR: The following module vitest configs are missing from vitest.workspace.ts:\n' +
      missing.map((p) => `  - ${p}`).join('\n') +
      '\n\nAdd each path as a string entry in the defineWorkspace([...]) array.',
  );
  process.exit(1);
}

console.log(
  `[check-vitest-workspace] OK — all ${moduleNames.length} module vitest configs are present in vitest.workspace.ts`,
);
process.exit(0);
