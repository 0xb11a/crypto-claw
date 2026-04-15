#!/usr/bin/env node
/**
 * create-issue.js — Create or update GitHub issues via gh CLI
 *
 * Usage:
 *   node scripts/create-issue.js --title "..." --body "..." [--labels "observer-auto,execution"] [--update-issue 42]
 *
 * Env vars: GH_PAT, OBSERVER_ISSUES_REPO
 *
 * Output: JSON with { ok, issue_number, url } or { ok: false, error }
 * Applies final redaction pass before posting.
 */

import 'dotenv/config';
import { execFileSync } from 'child_process';
import { redact } from './redact.js';
import { log } from './log.js';

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

function main() {
  const title = getArg('title');
  const body = getArg('body');
  const labels = getArg('labels') || 'observer-auto';
  const updateIssue = getArg('update-issue');
  const repo = process.env.OBSERVER_ISSUES_REPO;
  const token = process.env.GH_PAT;

  if (!title && !updateIssue) {
    log('error', 'create-issue', 'Missing --title argument');
    console.log(JSON.stringify({ ok: false, error: 'Missing --title argument' }));
    process.exit(1);
  }

  if (!repo) {
    log('error', 'create-issue', 'OBSERVER_ISSUES_REPO not set');
    console.log(JSON.stringify({ ok: false, error: 'OBSERVER_ISSUES_REPO env var not set' }));
    process.exit(1);
  }

  if (!token) {
    log('error', 'create-issue', 'GH_PAT not set');
    console.log(JSON.stringify({ ok: false, error: 'GH_PAT env var not set' }));
    process.exit(1);
  }

  // Final redaction pass — defense in depth
  const safeTitle = redact(title || '');
  const safeBody = redact(body || '');

  try {
    const env = { ...process.env, GH_TOKEN: token };

    if (updateIssue) {
      // Add a comment to an existing issue
      execFileSync('gh', ['issue', 'comment', updateIssue, '--repo', repo, '--body', safeBody || safeTitle], {
        encoding: 'utf-8',
        timeout: 30_000,
        env,
      });

      log('info', 'create-issue', `Commented on issue #${updateIssue} in ${repo}`);
      console.log(
        JSON.stringify(
          {
            ok: true,
            issue_number: parseInt(updateIssue, 10),
            action: 'commented',
            repo,
          },
          null,
          2,
        ),
      );
    } else {
      // Create a new issue
      const args = ['issue', 'create', '--repo', repo, '--title', safeTitle, '--body', safeBody];

      // Add labels
      for (const label of labels
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean)) {
        args.push('--label', label);
      }

      const result = execFileSync('gh', args, { encoding: 'utf-8', timeout: 30_000, env });

      // gh issue create outputs the URL
      const url = result.trim();
      const issueNum = url.match(/\/issues\/(\d+)/)?.[1];

      log('info', 'create-issue', `Created issue #${issueNum} in ${repo}: ${safeTitle}`);
      console.log(
        JSON.stringify(
          {
            ok: true,
            issue_number: issueNum ? parseInt(issueNum, 10) : null,
            url,
            action: 'created',
            repo,
          },
          null,
          2,
        ),
      );
    }
  } catch (err) {
    const errorMsg = err.message || String(err);
    log('error', 'create-issue', `GitHub API failed: ${errorMsg}`);
    console.log(JSON.stringify({ ok: false, error: redact(errorMsg) }));
    process.exit(1);
  }
}

main();
