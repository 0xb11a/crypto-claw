import { Min, Max, type ValidationOptions } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * @MinValue — composite decorator combining class-validator @Min and @ApiPropertyOptional({minimum}).
 *
 * Eliminates the boilerplate of pairing two decorators on every numeric field:
 *   Before: @ApiPropertyOptional({ minimum: 0 }) @Min(0) @IsInt() @IsOptional() field?: number;
 *   After:  @MinValue(0) @IsInt() @IsOptional() field?: number;
 *
 * The OpenAPI schema gains `minimum: min` automatically.
 */
export function MinValue(min: number, options?: ValidationOptions): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol): void {
    Min(min, options)(target, propertyKey);
    ApiPropertyOptional({ minimum: min })(target, propertyKey);
  };
}

/**
 * @MaxValue — composite decorator combining class-validator @Max and @ApiPropertyOptional({maximum}).
 *
 * Eliminates the boilerplate of pairing two decorators on every numeric field:
 *   Before: @ApiPropertyOptional({ maximum: 1_000_000 }) @Max(1_000_000) @IsInt() @IsOptional() field?: number;
 *   After:  @MaxValue(1_000_000) @IsInt() @IsOptional() field?: number;
 */
export function MaxValue(max: number, options?: ValidationOptions): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol): void {
    Max(max, options)(target, propertyKey);
    ApiPropertyOptional({ maximum: max })(target, propertyKey);
  };
}

/**
 * @MinMaxValue — composite decorator combining @Min, @Max, and @ApiPropertyOptional({minimum, maximum}).
 *
 * Ideal for fields with both a lower and upper bound:
 *   Before: @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000 }) @Min(0) @Max(1_000_000) field?: number;
 *   After:  @MinMaxValue(0, 1_000_000) @IsInt() @IsOptional() field?: number;
 */
export function MinMaxValue(min: number, max: number, options?: ValidationOptions): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol): void {
    Min(min, options)(target, propertyKey);
    Max(max, options)(target, propertyKey);
    ApiPropertyOptional({ minimum: min, maximum: max })(target, propertyKey);
  };
}
