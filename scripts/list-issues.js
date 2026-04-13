#!/usr/bin/env node
/**
 * list-issues.js — List GitHub issues via gh CLI
 *
 * Usage:
 *   node scripts/list-issues.js [--label "observer-auto"] [--state open] [--limit 20]
 *
 * Env vars: GITHUB_TOKEN, OBSERVER_ISSUES_REPO
 *
 * Output: JSON array of issues with { number, title, state, labels, body, url }
 */

import { execFileSync } from 'child_process';
import { log } from './log.js';

function getArg(name, defaultVal) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultVal;
}

function main() {
  const label = getArg('label', 'observer-auto');
  const state = getArg('state', 'open');
  const limit = getArg('limit', '20');
  const repo = process.env.OBSERVER_ISSUES_REPO;
  const token = process.env.GITHUB_TOKEN;

  if (!repo) {
    log('error', 'list-issues', 'OBSERVER_ISSUES_REPO not set');
    console.log(JSON.stringify({ ok: false, error: 'OBSERVER_ISSUES_REPO env var not set' }));
    process.exit(1);
  }

  if (!token) {
    log('error', 'list-issues', 'GITHUB_TOKEN not set');
    console.log(JSON.stringify({ ok: false, error: 'GITHUB_TOKEN env var not set' }));
    process.exit(1);
  }

  try {
    const env = { ...process.env, GH_TOKEN: token };

    const args = [
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      state,
      '--limit',
      limit,
      '--json',
      'number,title,state,labels,body,url',
    ];

    if (label) {
      args.push('--label', label);
    }

    const result = execFileSync('gh', args, { encoding: 'utf-8', timeout: 30_000, env });
    const issues = JSON.parse(result);

    console.log(JSON.stringify(issues, null, 2));
  } catch (err) {
    const errorMsg = err.message || String(err);
    log('error', 'list-issues', `GitHub API failed: ${errorMsg}`);
    console.log(JSON.stringify({ ok: false, error: errorMsg }));
    process.exit(1);
  }
}

main();
