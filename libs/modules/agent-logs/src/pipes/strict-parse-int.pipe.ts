import { Injectable, BadRequestException } from '@nestjs/common';
import type { PipeTransform, ArgumentMetadata } from '@nestjs/common';

/**
 * StrictParseIntPipe — rejects float / scientific / whitespace path params,
 * accepts plain decimal integer strings, and accepts already-coerced numbers.
 *
 * KNOWN LIMITATION: hex literals like `0xdeadbeef` are silently coerced to
 * decimal integers by NestJS's global `ValidationPipe` (transform: true)
 * BEFORE this pipe sees the value. By the time this pipe runs, `0xdeadbeef`
 * has become 3735928559 (a valid integer). The result: `GET .../0xdeadbeef`
 * returns 404 (id not found) rather than 400. Per-route ValidationPipe
 * overrides do NOT bypass the global APP_PIPE; we tried.
 *
 * What this pipe DOES catch:
 *   - `1.5`, `1e10`, ` 1` (leading whitespace), `abc`, `''` → 400
 *
 * What slips through (NestJS limitation, returns 404):
 *   - `0xdeadbeef`, `0o777`, `0b101` — coerced to integers via Number()
 *
 * Workarounds attempted:
 *   - Per-route `new ValidationPipe({ transform: false })` — does not override
 *     the global APP_PIPE.
 *   - Removing the number fast-path — broke valid integer paths too because
 *     the global pipe always coerces.
 *
 * To get true 400 on hex would require disabling `transform: true` globally
 * (large blast radius) or migrating to Zod-based validation. Deferred.
 */
@Injectable()
export class StrictParseIntPipe implements PipeTransform<string | number, number> {
  transform(value: string | number, _metadata: ArgumentMetadata): number {
    // Fast-path: global ValidationPipe already coerced the value to a number.
    // Accept finite integers; reject NaN / Infinity / floats.
    if (typeof value === 'number') {
      if (Number.isInteger(value) && Number.isFinite(value)) {
        return value;
      }
      throw new BadRequestException(`Validation failed (numeric string is expected, got '${String(value)}')`);
    }
    // String path: strict decimal regex.
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
      throw new BadRequestException(`Validation failed (numeric string is expected, got '${String(value)}')`);
    }
    return parseInt(value, 10);
  }
}
