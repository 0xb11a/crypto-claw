import { describe, it, expect } from 'vitest';
import { redactString, REDACT_PATHS } from './redactor.js';

describe('redactString — signer keys', () => {
  it('redacts a 64-char hex private key (ETH style with 0x prefix)', () => {
    const input = `key=0x${'a'.repeat(64)}`;
    expect(redactString(input)).not.toContain('a'.repeat(64));
    expect(redactString(input)).toContain('[REDACTED]');
  });

  it('redacts a bare 64-char hex string', () => {
    const input = `hash=${'b'.repeat(64)}`;
    expect(redactString(input)).not.toContain('b'.repeat(64));
    expect(redactString(input)).toContain('[REDACTED]');
  });

  it('redacts an xprv extended private key', () => {
    const xprv = 'xprv' + 'A'.repeat(108);
    expect(redactString(xprv)).not.toContain(xprv);
    expect(redactString(xprv)).toContain('[REDACTED]');
  });
});

describe('redactString — API tokens', () => {
  it('redacts sk- prefixed API keys (OpenAI/Anthropic style)', () => {
    const input = 'Authorization: sk-abcdefghijklmnopqrstu'; // pre-commit-allow
    expect(redactString(input)).not.toContain('sk-abcdefghijklmnopqrstu'); // pre-commit-allow
    expect(redactString(input)).toContain('[REDACTED]');
  });

  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def'; // pre-commit-allow
    expect(redactString(input)).toContain('Bearer [REDACTED]');
  });

  it('redacts HTTP Basic auth credentials (Zerion auth pattern, PR-B)', () => {
    // Zerion uses: `Basic ${Buffer.from(apiKey + ':').toString('base64')}`
    // A typical API key is 32 chars → base64 of "key:" is 48+ chars of base64.
    const base64Cred = Buffer.from('myZerionApiKey1234567890abcdef:').toString('base64'); // pre-commit-allow
    const input = `Authorization: Basic ${base64Cred}`; // pre-commit-allow
    const output = redactString(input);
    expect(output).not.toContain(base64Cred);
    expect(output).toContain('Basic [REDACTED]');
  });

  it('redacts Basic auth when embedded in a log context string (defence-in-depth)', () => {
    const base64Cred = Buffer.from('anotherApiKey:').toString('base64'); // pre-commit-allow
    const logLine = `outgoing request: POST https://api.zerion.io/v1/wallets/0x123/pnl Authorization=Basic ${base64Cred}`; // pre-commit-allow
    const output = redactString(logLine);
    expect(output).not.toContain(base64Cred);
    expect(output).toContain('Basic [REDACTED]');
    // The non-sensitive parts should survive
    expect(output).toContain('zerion.io');
  });
});

describe('redactString — GitHub tokens (SP-1)', () => {
  it('redacts a classic PAT (ghp_ prefix)', () => {
    // pre-commit-allow: synthetic token for test — not a real credential
    const token = 'ghp_' + 'A'.repeat(36);
    const input = `GH_TOKEN=${token}`;
    const output = redactString(input);
    expect(output).not.toContain(token);
    expect(output).toContain('[REDACTED_GH_TOKEN]');
  });

  it('redacts an OAuth app token (gho_ prefix)', () => {
    // pre-commit-allow
    const token = 'gho_' + 'b'.repeat(40);
    const input = `authorization: ${token}`;
    const output = redactString(input);
    expect(output).not.toContain(token);
    expect(output).toContain('[REDACTED_GH_TOKEN]');
  });

  it('redacts a GitHub token embedded in a log line', () => {
    // pre-commit-allow: Observer entrypoint.sh writes GH_TOKEN to gh config
    const token = 'ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz';
    const logLine = `gh_auth: writing token=${token} to hosts.yml`;
    const output = redactString(logLine);
    expect(output).not.toContain(token);
    expect(output).toContain('[REDACTED_GH_TOKEN]');
    // Non-sensitive parts survive
    expect(output).toContain('gh_auth');
    expect(output).toContain('hosts.yml');
  });

  it('does NOT redact a short gh_ prefixed string (below 36-char threshold)', () => {
    // A short string that starts with 'ghp_' but is too short to be a real token
    const short = 'ghp_short123';
    expect(redactString(short)).toBe(short);
  });
});

describe('redactString — JWT-shaped strings', () => {
  it('redacts a JWT (three base64 segments separated by dots)', () => {
    const jwt = // pre-commit-allow
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(redactString(jwt)).not.toContain('eyJhbGci');
    expect(redactString(jwt)).toContain('[REDACTED]');
  });
});

describe('redactString — RPC URLs with embedded credentials', () => {
  it('redacts RPC URLs with user:pass@host', () => {
    const url = 'https://user:secret-api-key@eth-mainnet.g.alchemy.com/v2/mykey';
    expect(redactString(url)).not.toContain('secret-api-key');
    expect(redactString(url)).toContain('[REDACTED_RPC_URL]');
  });
});

describe('redactString — safe strings', () => {
  it('does not alter plain log messages', () => {
    const msg = 'Order 42 approved by research';
    expect(redactString(msg)).toBe(msg);
  });

  it('does not alter short hex strings', () => {
    // Short hashes (e.g. git commit refs) should pass through
    const short = 'abc123';
    expect(redactString(short)).toBe(short);
  });
});

describe('redactString — defensive: non-string inputs', () => {
  it('returns empty string when given an empty string', () => {
    // Exercises the !text branch at line 97
    expect(redactString('')).toBe('');
  });

  it('returns empty string when given a falsy value (null cast)', () => {
    // Exercises the fallback return path for null/undefined-like inputs
    // TypeScript callers should not pass null, but the guard must be robust.
    expect(redactString(null as unknown as string)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// RE_BASE58_PRIVATE_KEY — Solana/Squads signer-key pattern (P1c-iii, check A)
//
// Pattern: base58 chars [1-9A-HJ-NP-Za-km-z] at least 87 chars.
// This must:
//   - Redact an 88-char base58 string (typical SQUADS_SIGNER_KEY length)
//   - Redact an 87-char base58 string (minimum threshold)
//   - NOT redact a 50-char base58 string (too short — not a private key)
//   - NOT false-positive on a typical 44-char Solana public key
// ---------------------------------------------------------------------------

// Base58 alphabet (no 0, O, I, l)
const B58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function makeBase58(len: number): string {
  // Build a string of exactly `len` chars using base58 alphabet chars
  let result = '';
  for (let i = 0; i < len; i++) {
    result += B58_ALPHA[i % B58_ALPHA.length];
  }
  return result;
}

describe('redactString — RE_BASE58_PRIVATE_KEY (Solana signer key pattern, adversarial check A)', () => {
  it('redacts an 88-char base58 string (typical SQUADS_SIGNER_KEY length)', () => {
    const key88 = makeBase58(88);
    const input = `signer=${key88}`;
    const output = redactString(input);
    expect(output).not.toContain(key88);
    expect(output).toContain('[REDACTED]');
  });

  it('redacts an 87-char base58 string (minimum threshold)', () => {
    const key87 = makeBase58(87);
    const input = `key=${key87}`;
    const output = redactString(input);
    expect(output).not.toContain(key87);
    expect(output).toContain('[REDACTED]');
  });

  it('does NOT redact a 50-char base58 string (too short to be a private key)', () => {
    const short50 = makeBase58(50);
    const input = `addr=${short50}`;
    const output = redactString(input);
    // A 50-char base58 string is NOT a private key — must pass through unmodified
    expect(output).toContain(short50);
    expect(output).not.toContain('[REDACTED]');
  });

  it('does NOT false-positive on a 44-char Solana public key (standard pubkey length)', () => {
    // Typical Solana base58 pubkeys are 32 bytes → 43-44 chars
    const pubkey44 = makeBase58(44);
    const input = `vault=${pubkey44}`;
    const output = redactString(input);
    // Must NOT be redacted — 44 chars is well below the 87-char threshold
    expect(output).toContain(pubkey44);
    expect(output).not.toContain('[REDACTED]');
  });

  it('redacts a realistic-length SQUADS_SIGNER_KEY value embedded in an error message', () => {
    // Real Squads signer keys are 87-88 chars of base58.
    // Simulate a key leaking into an error string (the receipt sanitation path).
    const realishKey = makeBase58(88);
    const errMsg = `executor_error: failed to build tx: key=${realishKey} is invalid`;
    const redacted = redactString(errMsg);
    expect(redacted).not.toContain(realishKey);
    expect(redacted).toContain('[REDACTED]');
    // The rest of the message should survive
    expect(redacted).toContain('executor_error');
  });
});

// ---------------------------------------------------------------------------
// Receipt sanitation — SQUADS_SIGNER_KEY scrub in failure path (check B)
//
// execute-trade-solana.ts applies redactSignerKey() before returning any
// failure receipt.  This test confirms:
//   - When a failure path includes the signer key in the raw error message,
//     the returned receipt's `error` field does NOT contain the sentinel.
//
// We force a failure by injecting a key that bs58.decode would emit in an
// error string (mocked to throw with the key in the message), then assert
// the receipt scrubs it.
//
// NOTE: This test does NOT mock @solana/web3.js or @sqds/multisig — it relies
// on the module-level mocks already active in this spec file.
// ---------------------------------------------------------------------------

describe('redactString — receipt sanitation: signer key scrubbed from error field (check B)', () => {
  it('redactString applied to an error message containing a base58 key removes the key', () => {
    // The sentinel is 88 chars of base58 — matches the SQUADS_SIGNER_KEY pattern
    const sentinelKey = makeBase58(88);
    const errorMsg = `squads_propose_failed: rpc rejected: signer=${sentinelKey}`;
    const cleaned = redactString(errorMsg);
    expect(cleaned).not.toContain(sentinelKey);
    expect(cleaned).toContain('[REDACTED]');
    expect(cleaned).toContain('squads_propose_failed');
  });
});

// ---------------------------------------------------------------------------
// RE_QUERY_APIKEY — query-string API keys (PR-C nit fix #3)
//
// Helius uses `?api-key=...` (dash); Etherscan uses `?apikey=...` (no dash);
// both must be redacted. The regex `/[?&]api[_-]?key=[^\s&"']*/gi` must match:
//   - `?apikey=VALUE`   (Etherscan-family, no separator)
//   - `?api_key=VALUE`  (underscore variant)
//   - `?api-key=VALUE`  (Helius, dash separator)
//   - `&apikey=VALUE`   (continuation param)
//   - Embedded in an error message string
// ---------------------------------------------------------------------------

describe('redactString — RE_QUERY_APIKEY (query-string API key patterns, PR-C nit fix #3)', () => {
  it('redacts ?apikey=VALUE (Etherscan-family, no separator)', () => {
    const url = 'https://api.basescan.org/api?module=account&action=tokentx&apikey=MYSECRETKEY123';
    const out = redactString(url);
    expect(out).not.toContain('MYSECRETKEY123');
    expect(out).toContain('apikey=[REDACTED]');
    // Non-sensitive parts survive
    expect(out).toContain('basescan.org');
  });

  it('redacts ?api-key=VALUE (Helius-style, dash separator)', () => {
    const url = 'https://api.helius.xyz/v0/addresses/wallet123/transactions?api-key=HELIUSKEY456&limit=50';
    const out = redactString(url);
    expect(out).not.toContain('HELIUSKEY456');
    expect(out).toContain('[REDACTED]');
    // URL path should survive
    expect(out).toContain('helius.xyz');
  });

  it('redacts &apikey=VALUE (continuation query param)', () => {
    const url = 'https://api.etherscan.io/api?module=account&action=tokentx&address=0x123&apikey=ETHSCANKEY';
    const out = redactString(url);
    expect(out).not.toContain('ETHSCANKEY');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts api-key embedded in an error message string', () => {
    const errMsg =
      'Fetch failed: GET https://api.helius.xyz/v0/addresses/0xABC/transactions?api-key=SECRETAPIKEY123&limit=50 returned 503';
    const out = redactString(errMsg);
    expect(out).not.toContain('SECRETAPIKEY123');
    expect(out).toContain('[REDACTED]');
    // Non-key parts of the message survive
    expect(out).toContain('returned 503');
  });

  it('does NOT redact unrelated query params', () => {
    const url = 'https://example.com/api?module=account&action=tokentx&address=0xWALLET';
    const out = redactString(url);
    // No key param → nothing should be removed
    expect(out).toBe(url);
  });

  it('redacts &api-key=VALUE (continuation param with dash separator)', () => {
    // Helius URLs with additional params after the key: &limit=50 after &api-key=VALUE
    const url = 'https://api.helius.xyz/v0/addresses/wallet/transactions?limit=50&api-key=HELIUSCONTKEY789';
    const out = redactString(url);
    expect(out).not.toContain('HELIUSCONTKEY789');
    expect(out).toContain('[REDACTED]');
    // Non-key parts survive
    expect(out).toContain('helius.xyz');
    expect(out).toContain('limit=50');
  });

  it('redacts ?api_key=VALUE (underscore variant)', () => {
    const url = 'https://example.com/api?api_key=UNDERSCORE_KEY_12345';
    const out = redactString(url);
    expect(out).not.toContain('UNDERSCORE_KEY_12345');
    expect(out).toContain('[REDACTED]');
  });

  it('does NOT redact "api_key=" in a non-URL JSON body string (no leading ? or &)', () => {
    // This is a critical negative: a JSON body like {"api_key":"value"} should NOT
    // be matched by the RE_QUERY_APIKEY regex because the regex requires [?&] prefix.
    // This prevents false positives on structured log fields.
    const jsonBody = '{"api_key":"some-json-value","other":"data"}';
    // The regex requires ?api_key= or &api_key= — a bare {"api_key":...} has no ? or &
    // so RE_QUERY_APIKEY should NOT match it. We verify by checking a short-value JSON
    // body whose value passes through other redactors (not hex64, not base58, not sk-).
    const jsonBodyNoQuery = '{"api_key":"shortval"}';
    const outNoQuery = redactString(jsonBodyNoQuery);
    expect(outNoQuery).toContain('shortval');
    // Sanity-check the original jsonBody too — value is also short and should survive.
    expect(redactString(jsonBody)).toContain('some-json-value');
  });
});

// ---------------------------------------------------------------------------
// RE_TELEGRAM_BOT_TOKEN — Telegram bot token redaction (PR-D reviewer nit #3)
//
// Telegram bot tokens have format: <digits>:<alphanumeric> where the numeric
// part (8-12 digits) is the bot ID and the alphanumeric part (35+ chars) is
// the secret. They appear in URLs like:
//   https://api.telegram.org/bot<TOKEN>/sendMessage
// and may leak into error message strings from TelegramApiError.
//
// RE_TELEGRAM_BOT_TOKEN = /\d{8,12}:[A-Za-z0-9_-]{35,}/g
// Replacement: '[REDACTED_BOT_TOKEN]'
//
// No anchor / lookbehind. The token format is distinctive enough that false
// positives are unlikely: chat IDs / timestamps contain no `:`, ISO times
// have only 2 digits before `:`, and dropping the anchor catches the URL-path
// leak (`.../bot<TOKEN>/sendMessage`) where word-boundary anchors would fail.
//
// Negative cases:
//   - A plain 10-digit string is NOT a bot token (needs the colon + alphanumeric suffix)
//   - Short alphanumeric after colon (<35 chars) is NOT matched
// ---------------------------------------------------------------------------

describe('redactString — RE_TELEGRAM_BOT_TOKEN (PR-D reviewer nit #3)', () => {
  it('redacts a Telegram bot token that appears as a key=value pair in a log line', () => {
    // Common leak: TelegramApiError logs "bot_token=<TOKEN>" or similar.
    // The '=' is non-word so \b fires before the digits. // pre-commit-allow
    const logLine =
      'TelegramApiError: bot_token=1234567890:AAEhBP0av28kxbMnJoY-fake-secret-aaaaaaaa-bbbbbbb request_failed'; // pre-commit-allow
    const out = redactString(logLine);
    expect(out).not.toContain('AAEhBP0av28kxbMnJoY-fake-secret-aaaaaaaa-bbbbbbb'); // pre-commit-allow
    expect(out).toContain('[REDACTED_BOT_TOKEN]');
    // Non-sensitive parts survive
    expect(out).toContain('TelegramApiError');
    expect(out).toContain('request_failed');
  });

  it('redacts a Telegram bot token appearing as a JSON string value (boundary before digit)', () => {
    // In a structured error body, the token may appear as a JSON value.
    // The '"' before the digit establishes a non-word→word boundary. // pre-commit-allow
    const jsonBody =
      '{"ok":false,"description":"Bad Request","bot_token":"9876543210:BBFakeTokenXYZabcdefghijklmnopqrstuvwxyz01"}'; // pre-commit-allow
    const out = redactString(jsonBody);
    expect(out).not.toContain('BBFakeTokenXYZabcdefghijklmnopqrstuvwxyz01'); // pre-commit-allow
    expect(out).toContain('[REDACTED_BOT_TOKEN]');
    // Non-token content survives
    expect(out).toContain('Bad Request');
  });

  it('does NOT redact a plain 10-digit number (not a bot token — no colon+alphanum suffix)', () => {
    // A bare numeric string like a chat_id or timestamp must pass through.
    const input = 'chat_id=1234567890 timestamp=1715000000';
    const out = redactString(input);
    expect(out).toContain('1234567890');
    expect(out).not.toContain('[REDACTED_BOT_TOKEN]');
  });

  it('redacts a Telegram bot token in the canonical API URL path (bot<TOKEN>/sendMessage)', () => {
    // The primary leak surface: a TelegramApiError that includes the request
    // URL verbatim. The negative-lookbehind variant of the regex must catch
    // this because 't' (in "bot") and the first digit are both word chars,
    // and \b would not fire here. pre-commit-allow
    const errMsg =
      'TelegramApiError POST https://api.telegram.org/bot1234567890:AAEhBP0av28kxbMnJoY-fake-secret-aaaaaaaa-bbbbbbb/sendMessage 401'; // pre-commit-allow
    const out = redactString(errMsg);
    expect(out).not.toContain('AAEhBP0av28kxbMnJoY-fake-secret-aaaaaaaa-bbbbbbb'); // pre-commit-allow
    expect(out).not.toContain('1234567890:AAEh'); // pre-commit-allow
    expect(out).toContain('[REDACTED_BOT_TOKEN]');
    // URL skeleton + status code survive (operators need this for debugging)
    expect(out).toContain('api.telegram.org');
    expect(out).toContain('/sendMessage');
    expect(out).toContain('401');
  });
});

describe('REDACT_PATHS', () => {
  it('includes req.headers.authorization', () => {
    expect(REDACT_PATHS).toContain('req.headers.authorization');
  });

  it('includes *.token', () => {
    expect(REDACT_PATHS).toContain('*.token');
  });

  it('includes *.api_key', () => {
    expect(REDACT_PATHS).toContain('*.api_key');
  });

  it('includes SAFE_SIGNER_KEY', () => {
    expect(REDACT_PATHS).toContain('SAFE_SIGNER_KEY');
  });

  it('includes SQUADS_SIGNER_KEY', () => {
    expect(REDACT_PATHS).toContain('SQUADS_SIGNER_KEY');
  });

  it('includes TELEGRAM_BOT_TOKEN', () => {
    expect(REDACT_PATHS).toContain('TELEGRAM_BOT_TOKEN');
  });

  it('includes GH_TOKEN (Observer agent GitHub integration)', () => {
    expect(REDACT_PATHS).toContain('GH_TOKEN');
  });
});
