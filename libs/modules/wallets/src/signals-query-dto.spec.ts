/**
 * Unit tests for SignalsQueryDto — focuses on the @Transform decorator for
 * tokens_in_positions and the string coercion semantics Fastify exercises.
 *
 * Coder-flagged uncertainty 3: "tokens_in_positions=true query coercion —
 * Fastify passes query params as strings. The @Transform decorator must coerce
 * 'true'/'false' correctly."
 *
 * We test the Transform function directly rather than spinning up a Fastify
 * server, because the DTO shape is a pure function transform applied by
 * class-transformer. The integration-level routing test is in
 * tests/integration/security/auth.spec.ts (which exercises the full stack).
 *
 * SPEC §14 — unit test: pure-function DTO transform logic.
 * DoD §A — adversarial: coercion edge cases the coder flagged.
 */

import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SignalsQueryDto } from './dto/signals-query.dto.js';

/**
 * Helper: instantiate the DTO from a plain object (simulating what
 * NestJS/Fastify does with query params — everything arrives as string).
 */
function fromQuery(plain: Record<string, unknown>): SignalsQueryDto {
  return plainToInstance(SignalsQueryDto, plain, { enableImplicitConversion: false });
}

describe('SignalsQueryDto — tokens_in_positions coercion (SPEC §14, DoD §A)', () => {
  it("coerces string 'true' to boolean true", () => {
    const dto = fromQuery({ tokens_in_positions: 'true' });
    expect(dto.tokens_in_positions).toBe(true);
  });

  it("coerces string 'false' to boolean false", () => {
    const dto = fromQuery({ tokens_in_positions: 'false' });
    expect(dto.tokens_in_positions).toBe(false);
  });

  it('passes through boolean true unchanged', () => {
    const dto = fromQuery({ tokens_in_positions: true });
    expect(dto.tokens_in_positions).toBe(true);
  });

  it('passes through boolean false unchanged', () => {
    const dto = fromQuery({ tokens_in_positions: false });
    expect(dto.tokens_in_positions).toBe(false);
  });

  it('returns undefined when tokens_in_positions is not present', () => {
    const dto = fromQuery({});
    expect(dto.tokens_in_positions).toBeUndefined();
  });

  it("does NOT coerce string '1' or '0' to boolean (only 'true'/'false' strings)", () => {
    // The Transform only handles 'true'/'false'; '1' is passed through as-is.
    // class-validator @IsBoolean() will then reject it. This tests the transform boundary.
    const dto = fromQuery({ tokens_in_positions: '1' });
    // '1' is not 'true' and not 'false' → transform returns the raw value
    expect(dto.tokens_in_positions).toBe('1');
  });
});

describe('SignalsQueryDto — since validation (SPEC §14)', () => {
  it('accepts 35m as valid since value', async () => {
    const dto = fromQuery({ since: '35m' });
    const errors = await validate(dto);
    const sinceErrors = errors.filter((e) => e.property === 'since');
    expect(sinceErrors).toHaveLength(0);
  });

  it('accepts 2h as valid since value', async () => {
    const dto = fromQuery({ since: '2h' });
    const errors = await validate(dto);
    const sinceErrors = errors.filter((e) => e.property === 'since');
    expect(sinceErrors).toHaveLength(0);
  });

  it('accepts 1d as valid since value', async () => {
    const dto = fromQuery({ since: '1d' });
    const errors = await validate(dto);
    const sinceErrors = errors.filter((e) => e.property === 'since');
    expect(sinceErrors).toHaveLength(0);
  });

  it('accepts 99999999m as valid (regex allows large numbers)', async () => {
    const dto = fromQuery({ since: '99999999m' });
    const errors = await validate(dto);
    const sinceErrors = errors.filter((e) => e.property === 'since');
    // The regex /^\d+[mhd]$/ allows any positive integer — no upper bound
    expect(sinceErrors).toHaveLength(0);
  });

  it('rejects since=5s (invalid unit)', async () => {
    const dto = fromQuery({ since: '5s' });
    const errors = await validate(dto);
    const sinceErrors = errors.filter((e) => e.property === 'since');
    expect(sinceErrors.length).toBeGreaterThan(0);
  });

  it('rejects since=abc (no digit prefix)', async () => {
    const dto = fromQuery({ since: 'abc' });
    const errors = await validate(dto);
    const sinceErrors = errors.filter((e) => e.property === 'since');
    expect(sinceErrors.length).toBeGreaterThan(0);
  });

  it('rejects since=m (missing digit)', async () => {
    const dto = fromQuery({ since: 'm' });
    const errors = await validate(dto);
    const sinceErrors = errors.filter((e) => e.property === 'since');
    expect(sinceErrors.length).toBeGreaterThan(0);
  });
});

describe('SignalsQueryDto — limit coercion (SPEC §14)', () => {
  it("coerces string '50' to integer 50", () => {
    const dto = fromQuery({ limit: '50' });
    expect(dto.limit).toBe(50);
  });

  it("coerces string '500' to integer 500 (max)", async () => {
    const dto = fromQuery({ limit: '500' });
    const errors = await validate(dto);
    const limitErrors = errors.filter((e) => e.property === 'limit');
    expect(limitErrors).toHaveLength(0);
    expect(dto.limit).toBe(500);
  });

  it("rejects string '501' (above max)", async () => {
    const dto = fromQuery({ limit: '501' });
    const errors = await validate(dto);
    const limitErrors = errors.filter((e) => e.property === 'limit');
    expect(limitErrors.length).toBeGreaterThan(0);
  });

  it("rejects string '0' (below min=1)", async () => {
    const dto = fromQuery({ limit: '0' });
    const errors = await validate(dto);
    const limitErrors = errors.filter((e) => e.property === 'limit');
    expect(limitErrors.length).toBeGreaterThan(0);
  });
});

describe('SignalsQueryDto — min_wallets coercion (SPEC §14)', () => {
  it("coerces string '2' to integer 2", () => {
    const dto = fromQuery({ min_wallets: '2' });
    expect(dto.min_wallets).toBe(2);
  });

  it("coerces string '0' to integer 0 (valid min)", async () => {
    const dto = fromQuery({ min_wallets: '0' });
    const errors = await validate(dto);
    const mwErrors = errors.filter((e) => e.property === 'min_wallets');
    expect(mwErrors).toHaveLength(0);
    expect(dto.min_wallets).toBe(0);
  });

  it("rejects string '-1' (below min=0)", async () => {
    const dto = fromQuery({ min_wallets: '-1' });
    const errors = await validate(dto);
    const mwErrors = errors.filter((e) => e.property === 'min_wallets');
    expect(mwErrors.length).toBeGreaterThan(0);
  });
});
