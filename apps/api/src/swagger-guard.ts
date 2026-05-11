/**
 * Swagger UI auth guard via Fastify `onRequest` hook (SPEC §11, ADR-0022).
 *
 * Intercepts all requests to `/v1/docs*` and `/v1/openapi.json` before they
 * reach the Swagger UI handler. Returns 401 unless the caller presents a valid
 * `agent`-role bearer token.
 *
 * The hook is registered on the raw Fastify instance BEFORE SwaggerModule.setup()
 * mounts the routes — this ensures unauthenticated callers don't even trigger
 * the file-system read.
 *
 * Note: the 401 response shape is hand-rolled here because Nest exception filters
 * don't run on pre-Nest Fastify hooks. This is documented as an intentional
 * minor inconsistency with the rest of the error envelope (ADR-0022 §Consequences).
 */

import { IdentityRegistry } from '@cclaw/auth';

// Use unknown for fastify instance to avoid version mismatch between
// @nestjs/platform-fastify's bundled fastify and the workspace's fastify.
// The hook is registered at runtime via a safe call pattern.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: avoid fastify version lock
type FastifyLike = any;

const SWAGGER_PATHS = ['/v1/docs', '/v1/openapi.json'];

/**
 * Checks whether the incoming Fastify request is for a Swagger UI asset.
 */
function isSwaggerPath(url: string): boolean {
  return SWAGGER_PATHS.some((prefix) => url === prefix || url.startsWith(prefix + '/') || url.startsWith(prefix + '?'));
}

/**
 * Register the Swagger UI auth hook on the Fastify instance.
 *
 * Must be called BEFORE SwaggerModule.setup() to guarantee the hook fires first.
 *
 * @param fastify - Raw Fastify instance from app.getHttpAdapter().getInstance()
 * @param registry - IdentityRegistry to validate bearer tokens
 */
export function registerSwaggerGuard(fastify: FastifyLike, registry: IdentityRegistry): void {
  fastify.addHook('onRequest', async (req: Record<string, unknown>, reply: Record<string, unknown>) => {
    const url: string = (req['url'] as string | undefined) ?? '';
    if (!isSwaggerPath(url)) return;

    const headers = (req['headers'] as Record<string, string | string[] | undefined>) ?? {};
    const authHeader = headers['authorization'];
    const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    const send = reply['send'] as (data: unknown) => Promise<void>;
    const status = reply['status'] as (code: number) => typeof reply;

    if (!authValue || typeof authValue !== 'string') {
      await send.call(status.call(reply, 401), {
        error: { code: 'unauthorized', message: 'Missing Authorization header' },
      });
      return;
    }

    const parts = authValue.split(' ');
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) {
      await send.call(status.call(reply, 401), {
        error: { code: 'unauthorized', message: 'Malformed Authorization header — expected: Bearer <token>' },
      });
      return;
    }

    const token = parts[1];
    const user = registry.lookup(token);
    if (!user || user.role !== 'agent') {
      await send.call(status.call(reply, 401), {
        error: { code: 'unauthorized', message: 'Swagger UI requires agent role bearer token' },
      });
      return;
    }
    // Auth passed — let the request continue
  });
}
