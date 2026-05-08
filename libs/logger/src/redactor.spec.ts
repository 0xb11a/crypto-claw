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
});
