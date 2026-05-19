// ============================================================
// redact.js — Sensitive Data Redaction
//
// Strips wallet addresses, private keys, API keys, and other
// sensitive data from strings before logging or external output.
// Uses deterministic regex — never relies on LLM judgment.
// ============================================================

// ETH private keys: 64 hex chars (often prefixed with 0x)
const ETH_PRIVATE_KEY = /0x[a-fA-F0-9]{64}\b/g;

// ETH addresses: 40 hex chars (0x prefix)
const ETH_ADDRESS = /0x[a-fA-F0-9]{40}\b/g;

// Solana addresses: base58, 32-44 chars (public keys, tx signatures)
// Matches base58 alphabet (no 0, O, I, l) of sufficient length
const SOLANA_ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,88}\b/g;

// Extended private keys (BIP32)
const XPRV_KEY = /xprv[a-zA-Z0-9]{107,108}/g;

// API keys: common patterns
const API_KEY_SK = /\bsk-[a-zA-Z0-9_-]{20,}/g; // OpenAI, Anthropic
const API_KEY_BEARER = /Bearer\s+[a-zA-Z0-9_.-]{20,}/gi;

// GitHub tokens (classic PAT ghp_, OAuth gho_, user-to-server ghu_,
// server-to-server ghs_, refresh ghr_).
// Observer agent writes GH_TOKEN to ~/.config/gh/hosts.yml; this pattern
// guards against tokens leaking into log strings or error messages.
// Synced from libs/logger/src/redactor.ts (SP-1).
const GITHUB_TOKEN = /gh[pousr]_[A-Za-z0-9_]{36,}/g;

// Generic hex secrets: standalone 64-char hex (likely private keys or hashes)
const HEX_SECRET = /\b[a-fA-F0-9]{64}\b/g;

// Known safe patterns to exclude from Solana address matching:
// - Common words that happen to be 32+ chars of base58
// - Token symbols, chain names, etc.
const SAFE_WORDS = new Set([
  'insufficient_cash',
  'validation_failed',
  'queued_in_safe',
  'queued_in_squads',
  'stale_price',
  'tx_failed',
  'no_price',
  'no_position',
  'emergency',
]);

/**
 * Redact sensitive data from a string.
 * Order matters: longer/more specific patterns first to avoid partial matches.
 *
 * @param {string} text - Input string (may contain sensitive data)
 * @returns {string} - Redacted string safe for logging/external output
 */
export function redact(text) {
  if (!text || typeof text !== 'string') return text || '';

  let result = text;

  // 1. Extended private keys (most specific, longest)
  result = result.replace(XPRV_KEY, '[REDACTED_XPRV]');

  // 1a. GitHub tokens (prefix-specific — apply before generic hex/base58 patterns)
  result = result.replace(GITHUB_TOKEN, '[REDACTED_GH_TOKEN]');

  // 2. ETH private keys (64 hex with 0x prefix — before addresses)
  result = result.replace(ETH_PRIVATE_KEY, '[REDACTED_KEY]');

  // 3. API keys
  result = result.replace(API_KEY_SK, '[REDACTED_API_KEY]');
  result = result.replace(API_KEY_BEARER, 'Bearer [REDACTED_TOKEN]');

  // 4. ETH addresses (40 hex with 0x prefix)
  result = result.replace(ETH_ADDRESS, '[REDACTED_ADDR]');

  // 5. Generic 64-char hex (catches remaining private keys, tx hashes)
  result = result.replace(HEX_SECRET, '[REDACTED_HEX]');

  // 6. Solana addresses (base58, 32-44 chars)
  // More aggressive — filter out known safe words
  result = result.replace(SOLANA_ADDRESS, (match) => {
    // Skip short matches that are likely normal text
    if (match.length < 32) return match;
    // Skip known safe words
    if (SAFE_WORDS.has(match.toLowerCase())) return match;
    // Skip if it looks like a normal English word (all lowercase, < 40 chars)
    if (match.length < 40 && /^[a-z]+$/.test(match)) return match;
    return '[REDACTED_SOL_ADDR]';
  });

  return result;
}

// ============================================================
// sanitizeUntrusted — for fields that originate from external
// untrusted sources (token names/symbols from DEXScreener, contract
// metadata from GoPlus, wallet symbols from Etherscan, etc.) before
// they are surfaced to an LLM agent.
//
// Different concern from redact():
//   redact()           — strips OUR secrets out of OUR strings (defensive)
//   sanitizeUntrusted() — strips THEIR injection out of THEIR strings (offensive)
//
// Strips:
//   - control chars (\x00-\x1F, \x7F-\x9F) except \n \t
//   - zero-width chars (​-‍, ﻿, ⁠, ᠎)
//   - bidi/RTL overrides (‪-‮, ⁦-⁩)
//   - tag-like sequences </…> </…> that could close LLM markup
//   - markdown code fences (```)
//   - excess length (default 64 chars; configurable per source)
// ============================================================

const CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g; // keep \n (0A) and \t (09)
const ZERO_WIDTH = /[​-‍﻿⁠᠎]/g;
const BIDI_OVERRIDE = /[‪-‮⁦-⁩]/g;
const CLOSING_TAG = /<\/?[a-zA-Z][^>]{0,200}>/g;
const CODE_FENCE = /```/g;

const DEFAULT_MAX_LEN = 64;

/**
 * Sanitize an untrusted external string before passing to an LLM.
 *
 * @param {string} str - Input from DEXScreener, GoPlus, etc.
 * @param {object} opts
 * @param {number} [opts.maxLen=64] - Length cap. Truncate beyond this.
 * @param {string} [opts.source='unknown'] - Source label (for the truncation marker).
 * @returns {string} - Sanitized string safe for LLM context.
 */
export function sanitizeUntrusted(str, opts = {}) {
  if (str === null || str === undefined) return '';
  if (typeof str !== 'string') str = String(str);

  const maxLen = Number.isFinite(opts.maxLen) && opts.maxLen > 0 ? opts.maxLen : DEFAULT_MAX_LEN;

  let result = str;

  // 1. Strip dangerous Unicode classes
  result = result.replace(BIDI_OVERRIDE, '');
  result = result.replace(ZERO_WIDTH, '');
  result = result.replace(CONTROL_CHARS, '');

  // 2. Neutralize markup that could escape an LLM context boundary
  result = result.replace(CLOSING_TAG, '');
  result = result.replace(CODE_FENCE, "'''");

  // 3. Cap length. Use a short, parseable marker so the model can see
  //    that truncation happened and won't read across the boundary.
  if (result.length > maxLen) {
    result = result.slice(0, maxLen) + '…[truncated]';
  }

  return result;
}

export default { redact, sanitizeUntrusted };
