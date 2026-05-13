import { describe, it, expect } from 'vitest';
import { canonicalJson } from './canonical-json.js';

describe('canonicalJson', () => {
  it('serialises primitives', () => {
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('hello')).toBe('"hello"');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
  });

  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested object keys', () => {
    const input = { z: { y: 3, x: 4 }, a: 1 };
    expect(canonicalJson(input)).toBe('{"a":1,"z":{"x":4,"y":3}}');
  });

  it('preserves array element order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('is stable across different insertion orders', () => {
    const obj1 = { c: 3, a: 1, b: 2 };
    const obj2 = { a: 1, b: 2, c: 3 };
    const obj3 = { b: 2, c: 3, a: 1 };
    expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
    expect(canonicalJson(obj2)).toBe(canonicalJson(obj3));
  });

  it('handles empty object', () => {
    expect(canonicalJson({})).toBe('{}');
  });

  it('handles empty array', () => {
    expect(canonicalJson([])).toBe('[]');
  });

  it('handles undefined values in objects (JSON.stringify drops them)', () => {
    const obj = { a: 1, b: undefined };
    // JSON.stringify drops undefined values; canonicalJson matches that behaviour
    expect(canonicalJson(obj)).toBe('{"a":1}');
  });
});
