/**
 * Unit tests for executor-path.ts
 */
import { describe, it, expect } from 'vitest';
import { getExecutorPath } from './executor-path.js';

describe('getExecutorPath()', () => {
  it('returns EXECUTOR_BIN_PATH override when set', () => {
    const result = getExecutorPath({ EXECUTOR_BIN_PATH: '/custom/path/executor.js' });
    expect(result).toBe('/custom/path/executor.js');
  });

  it('ignores empty EXECUTOR_BIN_PATH override', () => {
    const result = getExecutorPath({ EXECUTOR_BIN_PATH: '  ' });
    expect(result).toContain('apps/executor/dist/main.js');
  });

  it('returns a path ending in apps/executor/dist/main.js when no override', () => {
    const result = getExecutorPath({});
    expect(result).toContain('apps/executor/dist/main.js');
  });

  it('returns an absolute path', () => {
    const result = getExecutorPath({});
    expect(result.startsWith('/')).toBe(true);
  });
});
