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
 * Implementation note: NestJS may run the global ValidationPipe (with
 * `transform: true`) before this custom pipe, which can coerce the path-param
 * string to a JavaScript `number` before we see it. Accepting an already-parsed
 * integer directly avoids a spurious 400 in that code-path while still rejecting
 * floats (1.5), hex (0xdeadbeef), scientific notation (1e10), and whitespace (' 1').
 */
@Injectable()
export class StrictParseIntPipe implements PipeTransform<string | number, number> {
  transform(value: string | number, _metadata: ArgumentMetadata): number {
    // Fast-path: global ValidationPipe already coerced the string to an integer.
    if (typeof value === 'number') {
      if (Number.isInteger(value)) return value;
      throw new BadRequestException(`Validation failed (integer expected, got '${String(value)}')`);
    }
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
      throw new BadRequestException(`Validation failed (numeric string is expected, got '${String(value)}')`);
    }
    return parseInt(value, 10);
  }
}
