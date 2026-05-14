#!/usr/bin/env node
// check-dockerfile-modules.mjs
//
// Guards that every libs/modules/<name>/package.json has a corresponding
// COPY line in docker/Dockerfile. Exits 0 on success; exits 1 with a
// descriptive error listing missing entries.
//
// Usage:
//   node scripts/ci/check-dockerfile-modules.mjs
//
// Run in CI before the build step (Category F.10 — P2 cleanup).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const MODULES_DIR = join(REPO_ROOT, 'libs', 'modules');
const DOCKERFILE = join(REPO_ROOT, 'docker', 'Dockerfile');

const dockerfileContent = readFileSync(DOCKERFILE, 'utf8');

// Discover all libs/modules/<name>/package.json paths
const moduleNames = readdirSync(MODULES_DIR).filter((name) => {
  const dir = join(MODULES_DIR, name);
  if (!statSync(dir).isDirectory()) return false;
  try {
    statSync(join(dir, 'package.json'));
    return true;
  } catch {
    return false;
  }
});

const missing = [];

for (const name of moduleNames) {
  // Expected COPY line (the exact form used in docker/Dockerfile)
  const expectedLine = `COPY libs/modules/${name}/package.json libs/modules/${name}/`;
  if (!dockerfileContent.includes(expectedLine)) {
    missing.push(expectedLine);
  }
}

if (missing.length > 0) {
  console.error(
    '[check-dockerfile-modules] ERROR: The following module package.json COPY lines are missing from docker/Dockerfile:\n' +
      missing.map((l) => `  ${l}`).join('\n') +
      '\n\nAdd each line to the "Copy all package.json files" section in docker/Dockerfile.',
  );
  process.exit(1);
}

console.log(
  `[check-dockerfile-modules] OK — all ${moduleNames.length} module package.json COPY lines present in docker/Dockerfile`,
);
process.exit(0);
