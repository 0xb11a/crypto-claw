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

  // Birdeye and other external-API key headers (P3g1 — BirdeyeAdapter)
  'req.headers["x-api-key"]',
  'req.headers["X-API-KEY"]',

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
  'BIRDEYE_API_KEY',
  'HELIUS_API_KEY',
  'ZERION_API_KEY',
  'RESEARCH_API_KEY',
  'SENTINEL_API_KEY',
  'EXECUTOR_API_KEY',
  'OBSERVER_API_KEY',
  'LOOP_API_KEY',
  'WORKER_API_KEY',
  'SCHEDULER_API_KEY',
  'DASHBOARD_API_KEY',
  // P3g2 PR-D: Telegram bot token (digit:alpha format in URL paths)
  'TELEGRAM_BOT_TOKEN',
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

/**
 * HTTP Basic auth credentials in strings.
 *
 * Matches `Basic <base64-value>` where the value is at least 16 chars of
 * base64 (A-Z, a-z, 0-9, +, /, =). Added in PR-B for ZerionAdapter which
 * authenticates via `Basic ${Buffer.from(apiKey + ':').toString('base64')}`.
 *
 * Pino REDACT_PATHS already covers `req.headers.authorization` in structured
 * JSON logs. This pattern covers the string-level redactor path used by
 * `redactString()` — e.g. when an Authorization header leaks into an error
 * message or log context field.
 */
const RE_BASIC_AUTH = /Basic\s+[a-zA-Z0-9+/=]{16,}/gi;

/** Generic 64-char hex (private keys, transaction hashes) */
const RE_HEX_64 = /\b[a-fA-F0-9]{64}\b/g;

/** Extended private keys (BIP32) */
const RE_XPRV = /xprv[a-zA-Z0-9]{107,108}/g;

/** JWT-shaped string: three base64url segments separated by dots */
const RE_JWT = /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g;

/** RPC URLs with embedded credentials: scheme://user:pass@host or ?apiKey=... */
const RE_RPC_CREDS = /https?:\/\/[^@\s]+:[^@\s]+@[^\s]+/g;

/**
 * Query-string API keys for Etherscan-family and Birdeye-style URLs.
 *
 * Matches: `?apikey=VALUE`, `?api_key=VALUE`, `&apikey=VALUE`, `&api_key=VALUE`
 * where VALUE is any non-whitespace sequence.
 *
 * Added in P3g1 for the BirdeyeAdapter and evm-explorer adapters (PR-C).
 */
const RE_QUERY_APIKEY = /[?&]api[_-]?key=[^\s&"']*/gi;

/**
 * Base58-encoded Solana private keys.
 * Squads/Solana signer keys are base58-encoded 64-byte secrets (87-88 chars).
 * Pattern: base58 alphabet chars (1-9A-HJ-NP-Za-km-z), at least 87 chars long.
 * This catches SQUADS_SIGNER_KEY values that leak into error strings or logs.
 */
const RE_BASE58_PRIVATE_KEY = /\b[1-9A-HJ-NP-Za-km-z]{87,88}\b/g;

/**
 * Telegram bot tokens in URL paths (P3g2 PR-D — TelegramAdapter).
 *
 * Telegram bot tokens have the format: `<digits>:<alphanumeric>` where the
 * numeric part is the bot ID and the alphanumeric part is the secret.
 * They appear in URLs like `https://api.telegram.org/bot<token>/sendMessage`.
 *
 * This pattern catches tokens that leak into log messages (e.g. error strings
 * from TelegramApiError that include the request URL).
 *
 * Note: `RE_RPC_CREDS` does NOT cover Telegram URLs — that pattern requires
 * a `user:pass@host` form (HTTP Basic auth in the URL), which Telegram URLs
 * do not use. `RE_TELEGRAM_BOT_TOKEN` is the sole defence for Telegram bot
 * token patterns in both URL paths and error message strings.
 *
 * No anchor / lookbehind is used. The format `<8-12 digits>:<35+ alphanumeric-or-dash-or-underscore>`
 * is distinctive enough that false positives are unlikely: chat IDs and
 * timestamps don't contain `:`; ISO timestamps have only 2 digits before `:`;
 * URL paths embed the token directly after `bot` (where a word-boundary anchor
 * would silently fail to fire). Anchoring trades the URL-leak case for a
 * negligible false-positive risk on pure-numeric sequences mid-string.
 */
const RE_TELEGRAM_BOT_TOKEN = /\d{8,12}:[A-Za-z0-9_-]{35,}/g;

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
  result = result.replace(RE_BASE58_PRIVATE_KEY, '[REDACTED]'); // Solana/Squads signer keys (base58 ≥87 chars)
  result = result.replace(RE_TELEGRAM_BOT_TOKEN, '[REDACTED_BOT_TOKEN]'); // Telegram bot tokens
  result = result.replace(RE_API_KEY_SK, '[REDACTED]');
  result = result.replace(RE_BEARER, 'Bearer [REDACTED]');
  result = result.replace(RE_BASIC_AUTH, 'Basic [REDACTED]');
  result = result.replace(RE_JWT, '[REDACTED]');
  result = result.replace(RE_RPC_CREDS, '[REDACTED_RPC_URL]');
  result = result.replace(RE_HEX_64, '[REDACTED]');
  result = result.replace(RE_QUERY_APIKEY, (match) => match.replace(/=[^\s&"']*$/, '=[REDACTED]'));

  return result;
}

/** Pino redact configuration object, ready to pass to `pino({ redact: ... })`. */
export const pinoRedactConfig = {
  paths: REDACT_PATHS,
  censor: '[Redacted]',
} as const;
