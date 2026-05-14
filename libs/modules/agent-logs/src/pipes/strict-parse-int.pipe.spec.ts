/**
 * Unit tests for StrictParseIntPipe (DoD §A, P2 cleanup commit 6).
 *
 * Verifies that only plain decimal integer strings are accepted and all other
 * formats are rejected with BadRequestException.
 */
import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { StrictParseIntPipe } from './strict-parse-int.pipe.js';

const pipe = new StrictParseIntPipe();
const meta = {} as Parameters<typeof pipe.transform>[1];

describe('StrictParseIntPipe', () => {
  it("accepts '0'", () => {
    expect(pipe.transform('0', meta)).toBe(0);
  });

  it("accepts '123'", () => {
    expect(pipe.transform('123', meta)).toBe(123);
  });

  it("accepts '-1' (negative integer)", () => {
    expect(pipe.transform('-1', meta)).toBe(-1);
  });

  it("rejects '' (empty string)", () => {
    expect(() => pipe.transform('', meta)).toThrow(BadRequestException);
  });

  it("rejects '0xdeadbeef' (hex literal)", () => {
    expect(() => pipe.transform('0xdeadbeef', meta)).toThrow(BadRequestException);
  });

  it("rejects '1.5' (float)", () => {
    expect(() => pipe.transform('1.5', meta)).toThrow(BadRequestException);
  });

  it("rejects '1e10' (scientific notation)", () => {
    expect(() => pipe.transform('1e10', meta)).toThrow(BadRequestException);
  });

  it("rejects ' 1' (leading whitespace)", () => {
    expect(() => pipe.transform(' 1', meta)).toThrow(BadRequestException);
  });

  it('rejects undefined (non-string)', () => {
    // Simulates a missing path param passed as undefined
    expect(() => pipe.transform(undefined as unknown as string, meta)).toThrow(BadRequestException);
  });

  it('error message includes the invalid value', () => {
    try {
      pipe.transform('0xdeadbeef', meta);
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toContain('0xdeadbeef');
    }
  });
});
