import { Injectable, BadRequestException } from '@nestjs/common';
import type { PipeTransform, ArgumentMetadata } from '@nestjs/common';

/**
 * StrictParseIntPipe — rejects anything that is not a plain decimal integer
 * string (e.g. rejects '0xdeadbeef', '1.5', '1e10', ' 1').
 *
 * NestJS's built-in ParseIntPipe uses Number() coercion which accepts hex
 * literals and scientific notation silently. This pipe uses a strict decimal
 * regex to ensure only sequences of optional leading '-' followed by digits
 * are accepted.
 *
 * Used by agent-log controllers for the `:id` path parameter so that
 * `GET /v1/logs/research/0xdeadbeef` returns 400 (not 404 via coercion to 0).
 *
 * Usage: pair with a per-route `new ValidationPipe({ transform: false })` placed
 * BEFORE this pipe in the @Param decorator. This prevents the global ValidationPipe
 * (transform: true) from coercing the raw URL string to a JS number before this
 * pipe sees it — which would cause hex literals like '0xdeadbeef' to be silently
 * coerced to 3735928559 (a valid integer) instead of being rejected.
 *
 * Example:
 *   @Param('id', new ValidationPipe({ transform: false }), StrictParseIntPipe) id: number
 */
@Injectable()
export class StrictParseIntPipe implements PipeTransform<string, number> {
  transform(value: string, _metadata: ArgumentMetadata): number {
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
      throw new BadRequestException(`Validation failed (numeric string is expected, got '${String(value)}')`);
    }
    return parseInt(value, 10);
  }
}
