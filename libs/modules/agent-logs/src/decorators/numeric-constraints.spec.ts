/**
 * Unit tests for MinValue/MaxValue/MinMaxValue composite decorators (DoD §A, P2 cleanup Item 11).
 *
 * Verifies:
 * 1. @Min is applied (class-validator validates minimum)
 * 2. @Max is applied (class-validator validates maximum)
 * 3. @ApiPropertyOptional({minimum/maximum}) is applied (reflect-metadata has the swagger schema)
 * 4. Integration: @MinMaxValue both validates and contributes OpenAPI metadata
 */
import { describe, it, expect } from 'vitest';
import { validate, IsInt, IsOptional } from 'class-validator';
import { DECORATORS } from '@nestjs/swagger';
import { MinValue, MaxValue, MinMaxValue } from './numeric-constraints.js';

// Test DTO with MinMaxValue
class TestDto {
  @MinMaxValue(0, 1_000_000)
  @IsInt()
  @IsOptional()
  count?: number;
}

// Test DTO with separate MinValue and MaxValue
class TestDto2 {
  @MinValue(1)
  @MaxValue(500)
  @IsInt()
  @IsOptional()
  limit?: number;
}

describe('MinValue decorator', () => {
  it('Min is applied: value below minimum fails validation', async () => {
    const dto = new TestDto2();
    dto.limit = 0; // below @MinValue(1)
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('ApiPropertyOptional minimum metadata is set', () => {
    const apiMeta = (DECORATORS.getMetadata('apiModelProperties', TestDto2.prototype) as unknown[]) ?? [];
    const limitMeta = apiMeta.find((m: unknown) => (m as Record<string, unknown>)['name'] === 'limit') as
      | Record<string, unknown>
      | undefined;
    expect(limitMeta).toBeDefined();
    expect(limitMeta!['minimum']).toBe(1);
  });
});

describe('MaxValue decorator', () => {
  it('Max is applied: value above maximum fails validation', async () => {
    const dto = new TestDto2();
    dto.limit = 1000; // above @MaxValue(500)
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('ApiPropertyOptional maximum metadata is set', () => {
    const apiMeta = (DECORATORS.getMetadata('apiModelProperties', TestDto2.prototype) as unknown[]) ?? [];
    const limitMeta = apiMeta.find((m: unknown) => (m as Record<string, unknown>)['name'] === 'limit') as
      | Record<string, unknown>
      | undefined;
    expect(limitMeta).toBeDefined();
    expect(limitMeta!['maximum']).toBe(500);
  });
});

describe('MinMaxValue decorator', () => {
  it('validates minimum bound', async () => {
    const dto = new TestDto();
    dto.count = -1;
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('validates maximum bound', async () => {
    const dto = new TestDto();
    dto.count = 1_000_001;
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts value within range', async () => {
    const dto = new TestDto();
    dto.count = 42;
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('ApiPropertyOptional minimum and maximum metadata are set', () => {
    const apiMeta = (DECORATORS.getMetadata('apiModelProperties', TestDto.prototype) as unknown[]) ?? [];
    const countMeta = apiMeta.find((m: unknown) => (m as Record<string, unknown>)['name'] === 'count') as
      | Record<string, unknown>
      | undefined;
    expect(countMeta).toBeDefined();
    expect(countMeta!['minimum']).toBe(0);
    expect(countMeta!['maximum']).toBe(1_000_000);
  });
});
