/**
 * Unit tests for MaxJsonBytesConstraint (DoD §A, DoD §C).
 *
 * Covers:
 * - undefined → passes (optional field)
 * - null → passes
 * - valid object within limit → passes
 * - oversized object → fails
 * - oversized string value → fails
 * - circular reference → fails (JSON.stringify throws)
 */
import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { MaxJsonBytes } from './max-json-bytes.validator.js';

const LIMIT = 64;

class TestDto {
  @MaxJsonBytes(LIMIT)
  value?: unknown;
}

async function runValidation(value: unknown): Promise<string[]> {
  const dto = new TestDto();
  dto.value = value;
  const errors = await validate(dto);
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('MaxJsonBytesConstraint', () => {
  it('passes when value is undefined (optional field)', async () => {
    const dto = new TestDto();
    // value deliberately not set
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('passes when value is null', async () => {
    const errors = await runValidation(null);
    expect(errors).toHaveLength(0);
  });

  it('passes when JSON-serialised size is within the limit', async () => {
    // '{"a":1}' is 7 bytes — well within 64
    const errors = await runValidation({ a: 1 });
    expect(errors).toHaveLength(0);
  });

  it('fails when JSON-serialised object exceeds the limit', async () => {
    // Construct a string that, when JSON.stringify'd, exceeds 64 bytes
    const bigObj = { key: 'a'.repeat(100) };
    const errors = await runValidation(bigObj);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('64 bytes');
  });

  it('fails when JSON-serialised string value exceeds the limit', async () => {
    const bigString = 'x'.repeat(100);
    const errors = await runValidation(bigString);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails when value has a circular reference (JSON.stringify throws)', async () => {
    const circ: Record<string, unknown> = {};
    circ['self'] = circ; // circular
    const errors = await runValidation(circ);
    expect(errors.length).toBeGreaterThan(0);
  });
});
