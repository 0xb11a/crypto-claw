import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator.js';
import { AUDITED_KEY } from './audited-key.js';

const HTTP_METHOD_DECORATORS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'head', 'options'] as const;

const MUTATING_DECORATORS = new Set(['post', 'put', 'patch', 'delete', 'all']);

/** HTTP method metadata keys used by Nest decorators (NestJS stores them under 'method'). */
const METHOD_METADATA_KEY = 'method';

/**
 * Maps Nest's RequestMethod enum values to uppercase HTTP verb strings.
 *
 * Nest RequestMethod enum:
 *   GET=0, POST=1, PUT=2, DELETE=3, PATCH=4, ALL=5, OPTIONS=6, HEAD=7
 */
const NUMERIC_METHOD_TO_VERB: Record<number, string> = {
  0: 'GET',
  1: 'POST',
  2: 'PUT',
  3: 'DELETE',
  4: 'PATCH',
  5: 'ALL',
  6: 'OPTIONS',
  7: 'HEAD',
};

/**
 * Boot-time route walker (SPEC §4 #3, ADR-0019).
 *
 * Runs on `onApplicationBootstrap` and walks every registered controller
 * method. Throws (process.exit 78) if:
 * - Any handler is missing @Roles(…) metadata.
 * - Any non-GET handler is missing @Audited() metadata.
 *
 * This is the last line of defence — the ESLint rule catches issues at lint
 * time, this walker catches anything that slipped through to boot time.
 *
 * Error format mirrors SPEC §4 #6 config boot-fail:
 *   [boot] route <METHOD> <path> on <ControllerClass>#<method> missing @Roles(...)
 */
@Injectable()
export class RouteWalkerService implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const controllers = this.discovery.getControllers();
    const violations: string[] = [];

    for (const wrapper of controllers) {
      const instance = wrapper.instance as Record<string, unknown>;
      if (!instance || typeof instance !== 'object') continue;

      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      const methods = this.metadataScanner.getAllMethodNames(prototype);

      for (const methodName of methods) {
        const handler = prototype[methodName];
        if (typeof handler !== 'function') continue;

        // Check if this method is an HTTP handler by looking for method metadata
        const httpMethod: number | undefined = Reflect.getMetadata(METHOD_METADATA_KEY, handler);
        if (httpMethod === undefined) continue;

        const path: string = Reflect.getMetadata('path', handler) ?? '';
        const controllerName = wrapper.metatype?.name ?? 'unknown';

        const verb = NUMERIC_METHOD_TO_VERB[httpMethod] ?? String(httpMethod);

        // Check @Roles(...)
        const roles = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
          handler as Parameters<Reflector['getAllAndOverride']>[1][0],
          wrapper.metatype as Parameters<Reflector['getAllAndOverride']>[1][0],
        ]);
        if (!roles || roles.length === 0) {
          violations.push(`[boot] route ${verb} ${path} on ${controllerName}#${methodName} missing @Roles(...)`);
        }

        // Check @Audited() for non-GET methods
        // Nest RequestMethod enum: GET=0, POST=1, PUT=2, DELETE=3, PATCH=4, ALL=5, OPTIONS=6, HEAD=7
        const isNonGet = httpMethod !== 0; // 0 = RequestMethod.GET
        if (isNonGet) {
          const audited = this.reflector.getAllAndOverride<boolean | undefined>(AUDITED_KEY, [
            handler as Parameters<Reflector['getAllAndOverride']>[1][0],
            wrapper.metatype as Parameters<Reflector['getAllAndOverride']>[1][0],
          ]);
          if (!audited) {
            violations.push(`[boot] route ${verb} ${path} on ${controllerName}#${methodName} missing @Audited()`);
          }
        }
      }
    }

    if (violations.length > 0) {
      const msg = violations.join('\n');
      process.stderr.write(msg + '\n');
      process.exit(78);
    }

    // Log inspection summary at info level (SPEC ADR-0019 — operators can grep)
    process.stderr.write(`[boot] route walker: inspected ${controllers.length} controllers; all handlers decorated\n`);
  }
}

// Keep HTTP_METHOD_DECORATORS and MUTATING_DECORATORS in scope for the ESLint rule's tests.
// They are not exported from the module's public surface.
void HTTP_METHOD_DECORATORS;
void MUTATING_DECORATORS;
