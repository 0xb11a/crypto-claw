/**
 * Pino-compatible redaction configuration for the CryptoClaw logger.
 *
 * This module provides:
 * 1. A list of pino redact paths (for structured JSON log fields).
 * 2. A serialize-time string redactor for unstructured values.
 *
 * DO NOT DELETE OR MODIFY scripts/redact.js. This file is a TypeScript
 * port of the path list only. The legacy agent scripts still use the
 * original scripts/redact.js at runtime. Both files must be kept in sync
 * when new patterns are added.
 *
 * SPEC §9.7 — redaction patterns:
 *   - req.headers.authorization (Bearer token)
 *   - *.token, *.api_key (nested fields)
 *   - Signer-key hex patterns (64-char hex, 0x-prefixed 64-char hex)
 *   - JWT-shaped strings (three base64 segments separated by dots)
 *   - RPC URLs with embedded credentials
 *   - Extended private keys (xprv...)
 *   - OpenAI/Anthropic sk- prefixed keys
 */

/** Pino `redact.paths` entries. All matching fields are replaced with `[Redacted]`. */
export const REDACT_PATHS: string[] = [
  // HTTP authorization header
  'req.headers.authorization',

  // Common token field names at any depth
  '*.token',
  '*.api_key',
  '*.apiKey',
  '*.access_token',
  '*.accessToken',
  '*.secret',
  '*.privateKey',
  '*.private_key',
  '*.signerKey',
  '*.signer_key',
  '*.password',
  '*.credential',
  '*.credentials',

  // Auth-response shapes
  'body.token',
  'body.access_token',
  'body.refresh_token',

  // Specific env-var-shaped keys that might leak into log context
  'SAFE_SIGNER_KEY',
  'SQUADS_SIGNER_KEY',
  'OPENAI_API_KEY',
  'RESEARCH_API_KEY',
  'SENTINEL_API_KEY',
  'EXECUTOR_API_KEY',
  'OBSERVER_API_KEY',
  'LOOP_API_KEY',
  'WORKER_API_KEY',
  'SCHEDULER_API_KEY',
  'DASHBOARD_API_KEY',
];

// ---------------------------------------------------------------------------
// String-level redaction patterns (ported from scripts/redact.js)
// ---------------------------------------------------------------------------

/** ETH private keys: 0x + 64 hex chars */
const RE_ETH_PRIVATE_KEY = /0x[a-fA-F0-9]{64}\b/g;

/** SK-prefixed API keys (OpenAI, Anthropic) */
const RE_API_KEY_SK = /\bsk-[a-zA-Z0-9_-]{20,}/g;

/** Bearer token in strings */
const RE_BEARER = /Bearer\s+[a-zA-Z0-9_.-]{20,}/gi;

/** Generic 64-char hex (private keys, transaction hashes) */
const RE_HEX_64 = /\b[a-fA-F0-9]{64}\b/g;

/** Extended private keys (BIP32) */
const RE_XPRV = /xprv[a-zA-Z0-9]{107,108}/g;

/** JWT-shaped string: three base64url segments separated by dots */
const RE_JWT = /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g;

/** RPC URLs with embedded credentials: scheme://user:pass@host or ?apiKey=... */
const RE_RPC_CREDS = /https?:\/\/[^@\s]+:[^@\s]+@[^\s]+/g;

/**
 * Redact sensitive patterns from a raw string value.
 *
 * Applies the same patterns as `scripts/redact.js` in a TypeScript context.
 * Used for any log field that is a plain string rather than a structured object.
 *
 * @param text - The input string, which may contain secrets.
 * @returns The string with sensitive patterns replaced by `[REDACTED]`.
 */
export function redactString(text: string): string {
  if (!text || typeof text !== 'string') return text ?? '';

  let result = text;

  result = result.replace(RE_XPRV, '[REDACTED]');
  result = result.replace(RE_ETH_PRIVATE_KEY, '[REDACTED]');
  result = result.replace(RE_API_KEY_SK, '[REDACTED]');
  result = result.replace(RE_BEARER, 'Bearer [REDACTED]');
  result = result.replace(RE_JWT, '[REDACTED]');
  result = result.replace(RE_RPC_CREDS, '[REDACTED_RPC_URL]');
  result = result.replace(RE_HEX_64, '[REDACTED]');

  return result;
}

/** Pino redact configuration object, ready to pass to `pino({ redact: ... })`. */
export const pinoRedactConfig = {
  paths: REDACT_PATHS,
  censor: '[Redacted]',
} as const;
