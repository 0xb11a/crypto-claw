import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
  registerDecorator,
  type ValidationOptions,
  type ValidationArguments,
} from 'class-validator';

/**
 * @MaxJsonBytes — validates that a value, when serialised to JSON, does not
 * exceed `maxBytes` bytes.
 *
 * Applied to `score_breakdown` in AddTrackedWalletDto to prevent unbounded
 * JSON blobs from reaching the DB (DoD §C). Default ceiling: 16 384 bytes.
 *
 * Handles:
 * - `undefined` / `null` → passes (field is optional)
 * - non-serialisable values (circular references) → fails (returns false)
 * - values whose JSON serialisation exceeds maxBytes → fails
 */
@ValidatorConstraint({ name: 'MaxJsonBytes', async: false })
export class MaxJsonBytesConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === undefined || value === null) return true;
    const [maxBytes] = args.constraints as [number];
    try {
      const json = JSON.stringify(value);
      return Buffer.byteLength(json, 'utf8') <= maxBytes;
    } catch {
      // JSON.stringify threw (e.g. circular reference) — reject
      return false;
    }
  }

  defaultMessage(args: ValidationArguments): string {
    const [maxBytes] = args.constraints as [number];
    return `${args.property} must not exceed ${maxBytes} bytes when JSON-serialised`;
  }
}

/**
 * Decorator: validate that the field's JSON-serialised size does not exceed `maxBytes`.
 *
 * @param maxBytes - Maximum number of UTF-8 bytes for the JSON representation.
 * @param options  - Standard class-validator ValidationOptions.
 */
export function MaxJsonBytes(maxBytes: number, options?: ValidationOptions): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol): void {
    registerDecorator({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- registerDecorator requires constructor type
      target: (target as { constructor: Function }).constructor,
      propertyName: String(propertyKey),
      options,
      constraints: [maxBytes],
      validator: MaxJsonBytesConstraint,
    });
  };
}
