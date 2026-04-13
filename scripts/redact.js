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

export default { redact };
