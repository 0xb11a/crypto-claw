/**
 * Unit tests for RouteWalkerService (SPEC §4 #3, ADR-0019).
 *
 * The route walker must exit 78 (EX_CONFIG) if any handler lacks @Roles(...)
 * or any non-GET handler lacks @Audited().
 *
 * DoD §A — every code change has a test.
 * DoD §F — security changes: route walker is the boot-time default-deny enforcement.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { RouteWalkerService } from './route-walker.service.js';
import { ROLES_KEY } from './roles.decorator.js';
import { AUDITED_KEY } from './audited-key.js';
import { IDENTITIES_KEY } from './identities.decorator.js';
import type { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

// RequestMethod enum values (matches @nestjs/common RequestMethod)
const GET = 0;
const POST = 1;
const DELETE = 3;

/** Build a fake handler with method metadata. */
function makeHandler(method: number): object {
  const fn = function handler() {
    return;
  };
  Reflect.defineMetadata('method', method, fn);
  return fn;
}

/** Add @Roles metadata to a handler. */
function addRoles(handler: object, roles: string[]): void {
  Reflect.defineMetadata(ROLES_KEY, roles, handler);
}

/** Add @Audited metadata to a handler. */
function addAudited(handler: object): void {
  Reflect.defineMetadata(AUDITED_KEY, true, handler);
}

/** Add @Identities metadata to a handler. */
function addIdentities(handler: object, identities: string[]): void {
  Reflect.defineMetadata(IDENTITIES_KEY, identities, handler);
}

/** Build a fake controller wrapper. */
function makeController(name: string, methods: { name: string; handler: object }[]): object {
  const prototype: Record<string, object> = {};
  for (const m of methods) {
    prototype[m.name] = m.handler;
  }

  const instance = Object.create(prototype) as Record<string, unknown>;

  return {
    instance,
    metatype: { name },
  };
}

/** Build a RouteWalkerService with controlled fakes. */
function makeWalker(controllers: object[]): RouteWalkerService {
  const discovery = {
    getControllers: vi.fn().mockReturnValue(controllers),
  } as unknown as DiscoveryService;

  const metadataScanner = {
    getAllMethodNames: (proto: Record<string, unknown>) =>
      Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor'),
  } as unknown as MetadataScanner;

  const reflector = {
    getAllAndOverride: (key: string, targets: object[]) => {
      for (const t of targets) {
        const val = Reflect.getMetadata(key, t);
        if (val !== undefined) return val;
      }
      return undefined;
    },
  } as unknown as Reflector;

  return new RouteWalkerService(discovery, metadataScanner, reflector);
}

describe('RouteWalkerService', () => {
  let processExitSpy: any;

  let stderrSpy: any;

  let originalShadowMode: string | undefined;

  beforeEach(() => {
    // Default to shadow mode (1) for backward-compatible tests
    originalShadowMode = process.env['AUTHZ_SHADOW_MODE'];
    process.env['AUTHZ_SHADOW_MODE'] = '1';
  });

  afterEach(() => {
    processExitSpy?.mockRestore();
    stderrSpy?.mockRestore();
    if (originalShadowMode === undefined) {
      delete process.env['AUTHZ_SHADOW_MODE'];
    } else {
      process.env['AUTHZ_SHADOW_MODE'] = originalShadowMode;
    }
  });

  it('does NOT call process.exit when all handlers are properly decorated', () => {
    const getHandler = makeHandler(GET);
    addRoles(getHandler, ['agent', 'dashboard']);
    addIdentities(getHandler, ['*']);

    const postHandler = makeHandler(POST);
    addRoles(postHandler, ['agent']);
    addAudited(postHandler);
    addIdentities(postHandler, ['RESEARCH']);

    const ctrl = makeController('TestController', [
      { name: 'list', handler: getHandler },
      { name: 'create', handler: postHandler },
    ]);

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: any) => {
      throw new Error(`process.exit(${String(_code as number | undefined)}) called`);
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const walker = makeWalker([ctrl]);

    // Should not throw
    expect(() => walker.onApplicationBootstrap()).not.toThrow();
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('calls process.exit(78) when a GET handler is missing @Roles', () => {
    const getHandler = makeHandler(GET);
    // No @Roles added
    addIdentities(getHandler, ['*']);

    const ctrl = makeController('MissingRolesController', [{ name: 'list', handler: getHandler }]);

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: any) => {
      throw new Error(`process.exit(${String(_code as number | undefined)})`);
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const walker = makeWalker([ctrl]);

    expect(() => walker.onApplicationBootstrap()).toThrow('process.exit(78)');
    expect(processExitSpy).toHaveBeenCalledWith(78);
  });

  it('calls process.exit(78) when a non-GET handler is missing @Audited', () => {
    const postHandler = makeHandler(POST);
    addRoles(postHandler, ['agent']);
    // No @Audited added
    addIdentities(postHandler, ['RESEARCH']);

    const ctrl = makeController('MissingAuditedController', [{ name: 'create', handler: postHandler }]);

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: any) => {
      throw new Error(`process.exit(${String(_code as number | undefined)})`);
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const walker = makeWalker([ctrl]);

    expect(() => walker.onApplicationBootstrap()).toThrow('process.exit(78)');
    expect(processExitSpy).toHaveBeenCalledWith(78);
  });

  it('emits the SPEC §4 #6 / ADR-0019 format: [boot] route <METHOD> <path> on <Controller>#<method> missing @Roles(...)', () => {
    const getHandler = makeHandler(GET);
    Reflect.defineMetadata('path', '/test', getHandler);
    // Missing @Roles
    addIdentities(getHandler, ['*']);

    const ctrl = makeController('BadController', [{ name: 'list', handler: getHandler }]);

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: any) => {
      throw new Error(`process.exit(${String(_code as number | undefined)})`);
    });
    const messages: string[] = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      messages.push(String(msg));
      return true;
    });

    const walker = makeWalker([ctrl]);

    expect(() => walker.onApplicationBootstrap()).toThrow();
    // ADR-0019 format: [boot] route GET /test on BadController#list missing @Roles(...)
    expect(messages.join('')).toContain('[boot] route GET /test on BadController#list missing @Roles(...)');
  });

  it('calls process.exit(78) when a DELETE handler is missing @Audited', () => {
    const deleteHandler = makeHandler(DELETE);
    addRoles(deleteHandler, ['agent']);
    // No @Audited
    addIdentities(deleteHandler, ['RESEARCH']);

    const ctrl = makeController('NoAuditDeleteController', [{ name: 'remove', handler: deleteHandler }]);

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: any) => {
      throw new Error(`process.exit(${String(_code as number | undefined)})`);
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const walker = makeWalker([ctrl]);
    expect(() => walker.onApplicationBootstrap()).toThrow('process.exit(78)');
  });

  it('skips non-function prototype members', () => {
    const getHandler = makeHandler(GET);
    addRoles(getHandler, ['agent']);
    addIdentities(getHandler, ['*']);

    const proto: Record<string, unknown> = { list: getHandler, notAFunction: 'string value' };
    const instance = Object.create(proto) as Record<string, unknown>;
    const ctrl = { instance, metatype: { name: 'TestCtrl' } };

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: any) => {
      throw new Error(`process.exit(${String(_code as number | undefined)})`);
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const walker = makeWalker([ctrl]);
    // Should not throw — non-function members are skipped
    expect(() => walker.onApplicationBootstrap()).not.toThrow();
  });

  it('logs success message when all handlers are decorated', () => {
    const getHandler = makeHandler(GET);
    addRoles(getHandler, ['agent']);
    addIdentities(getHandler, ['*']);

    const ctrl = makeController('GoodController', [{ name: 'list', handler: getHandler }]);

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: any) => {
      throw new Error(`process.exit(${String(_code as number | undefined)})`);
    });
    const messages: string[] = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      messages.push(String(msg));
      return true;
    });

    const walker = makeWalker([ctrl]);
    walker.onApplicationBootstrap();

    expect(messages.join('')).toContain('[boot] route walker: inspected');
    expect(messages.join('')).toContain('all handlers decorated');
  });

  // ---------------------------------------------------------------------------
  // P7 — @Identities missing warn tests (ADR-0029)
  // ---------------------------------------------------------------------------

  it('emits a [warn] line (not exit 78) when @Identities is missing in shadow mode', () => {
    // Shadow mode (default in beforeEach)
    const getHandler = makeHandler(GET);
    addRoles(getHandler, ['agent', 'dashboard']);
    // No @Identities

    const ctrl = makeController('MissingIdentitiesController', [{ name: 'list', handler: getHandler }]);

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: any) => {
      throw new Error(`process.exit(${String(_code as number | undefined)})`);
    });
    const messages: string[] = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      messages.push(String(msg));
      return true;
    });

    const walker = makeWalker([ctrl]);
    // Should NOT throw (shadow mode: warn only)
    expect(() => walker.onApplicationBootstrap()).not.toThrow();
    expect(processExitSpy).not.toHaveBeenCalled();
    // Should emit a [warn] line
    expect(messages.join('')).toContain('[warn]');
    expect(messages.join('')).toContain('missing @Identities(...)');
  });

  it('exits 78 when @Identities is missing in enforce mode', () => {
    process.env['AUTHZ_SHADOW_MODE'] = '0'; // override to enforce

    const getHandler = makeHandler(GET);
    addRoles(getHandler, ['agent', 'dashboard']);
    // No @Identities

    const ctrl = makeController('EnforceMissingIdentitiesController', [{ name: 'list', handler: getHandler }]);

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: any) => {
      throw new Error(`process.exit(${String(_code as number | undefined)})`);
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const walker = makeWalker([ctrl]);
    expect(() => walker.onApplicationBootstrap()).toThrow('process.exit(78)');
    expect(processExitSpy).toHaveBeenCalledWith(78);
  });
});
