#!/usr/bin/env node
/**
 * pre-commit-check.js — Secret scanner for pre-commit hook
 *
 * Reads staged diff and checks added lines for accidental secrets.
 * Exit 0 = clean, Exit 1 = secrets found.
 */

import { execSync } from 'child_process';

const PATTERNS = [
  {
    name: 'hex-private-key',
    pattern: /0x[0-9a-fA-F]{64}\b/,
    description: 'Possible EVM private key (64 hex chars)',
  },
  {
    name: 'base58-private-key',
    pattern: /[1-9A-HJ-NP-Za-km-z]{85,90}/,
    description: 'Possible Solana private key (base58)',
  },
  {
    name: 'openai-key',
    pattern: /sk-[a-zA-Z0-9_-]{20,}/,
    description: 'Possible OpenAI API key',
  },
  {
    name: 'hardcoded-secret-assignment',
    pattern: /(API_KEY|SECRET|SIGNER_KEY|PRIVATE_KEY)\s*=\s*['"][^'"]{8,}['"]/,
    description: 'Hardcoded secret assignment',
  },
  {
    name: 'bearer-token',
    pattern: /Bearer\s+[a-zA-Z0-9_\-.]{20,}/,
    description: 'Possible Bearer token',
  },
  {
    name: 'rpc-with-key',
    pattern: /https?:\/\/.*\.(alchemy|infura)\..*\/[a-zA-Z0-9_-]{10,}/,
    description: 'RPC URL with embedded API key',
  },
];

const PLACEHOLDER_WORDS = ['YOUR_KEY', 'REDACTED', 'example', 'placeholder', '__none__'];

const FAKE_HEX_PATTERNS = [/^0x(deadbeef){8}/, /^0x(00){32}$/, /^0x(ff){32}$/, /^0x(12345678){8}/];

function isComment(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*');
}

function isAllowlisted(line, file) {
  if (file === '.env.example') return true;
  if (isComment(line)) return true;
  if (line.includes('process.env.')) return true;
  if (line.includes('// pre-commit-allow')) return true;
  if (PLACEHOLDER_WORDS.some((w) => line.includes(w))) return true;
  return false;
}

function isFakeHexKey(match) {
  return FAKE_HEX_PATTERNS.some((p) => p.test(match));
}

function main() {
  let diff;
  try {
    diff = execSync('git diff --cached -U0 --diff-filter=ACM', { encoding: 'utf-8' });
  } catch {
    // No staged files or git error — pass through
    process.exit(0);
  }

  if (!diff.trim()) {
    process.exit(0);
  }

  const findings = [];
  let currentFile = null;
  let lineNum = 0;

  for (const line of diff.split('\n')) {
    // Track current file
    const fileMatch = line.match(/^\+\+\+ b\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }

    // Track line numbers from hunk headers
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      lineNum = parseInt(hunkMatch[1], 10) - 1;
      continue;
    }

    // Only check added lines
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    lineNum++;

    const content = line.slice(1); // Remove leading '+'

    if (isAllowlisted(content, currentFile)) continue;

    for (const { name, pattern, description } of PATTERNS) {
      const match = content.match(pattern);
      if (!match) continue;

      // Extra check for hex keys — skip obviously fake ones
      if (name === 'hex-private-key' && isFakeHexKey(match[0])) continue;

      findings.push({
        file: currentFile,
        line: lineNum,
        rule: name,
        description,
        snippet: content.trim().slice(0, 80),
      });
    }
  }

  if (findings.length === 0) {
    process.exit(0);
  }

  console.error('\n🚨 Pre-commit secret scan found potential secrets:\n');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    Rule: ${f.rule} — ${f.description}`);
    console.error(`    Line: ${f.snippet}`);
    console.error('');
  }
  console.error('To suppress a false positive, add "// pre-commit-allow" to the line.');
  console.error('');
  process.exit(1);
}

main();
