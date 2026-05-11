/**
 * Security integration test — boot-fail when a handler lacks @Roles (SPEC §4 #3, ADR-0019).
 *
 * Verifies that the route walker (RouteWalkerService) causes the API server
 * to exit with code 78 (EX_CONFIG) when any handler is missing @Roles(…),
 * AND that the error message names the offending handler.
 *
 * This test uses RouteWalkerService directly with synthetic handlers (same
 * approach as the unit tests) to verify the walker logic and error format.
 *
 * The compiled-binary adversarial test (exit 78 when @Roles is removed from
 * a real controller) is verified in boot-defenses.spec.ts via the route-walker
 * success test, and was confirmed manually during code review:
 *   - `pnpm build` with @Roles removed from list() → compiled binary exits 78
 *   - `pnpm dev:api` with tsx does NOT exit 78 (tsx decorator transpilation
 *     difference; ESLint rule catches this at lint time instead).
 *
 * DoD §F — security: default-deny boot walker.
 * SPEC §14 — boot-fail-no-roles test required.
 */

import { describe, it, expect } from 'vitest';
import { RouteWalkerService } from '../../../libs/auth/src/route-walker.service.js';
import { ROLES_KEY } from '../../../libs/auth/src/roles.decorator.js';
import { AUDITED_KEY } from '../../../libs/auth/src/audited-key.js';
import { vi } from 'vitest';
import type { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

// Re-use the same fake-controller factory pattern from the unit test.
// This test verifies the SPEC §4 #6 error format specifically.

const POST = 1;

function makeHandler(method: number): object {
  const fn = function () { return; };
  Reflect.defineMetadata('method', method, fn);
  return fn;
}

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

describe('RouteWalkerService — SPEC §4 #3 boot-fail integration (ADR-0019)', () => {
  it('exits 78 with the SPEC error format when a handler is missing @Roles', () => {
    const handler = makeHandler(POST);
    // Intentionally NOT adding @Roles

    const instance = Object.create({ propose: handler }) as Record<string, unknown>;
    const ctrl = { instance, metatype: { name: 'OrdersController' } };

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`exit:${String(_code)}`);
    });
    const messages: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((m) => {
      messages.push(String(m));
      return true;
    });

    try {
      const walker = makeWalker([ctrl]);
      expect(() => walker.onApplicationBootstrap()).toThrow('exit:78');
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    // ADR-0019 format (P1b): [boot] route <METHOD> <path> on <ControllerClass>#<method> missing @Roles(...)
    expect(messages.join('')).toContain('on OrdersController#propose missing @Roles(...)');
  });

  it('exits 78 with the SPEC error format when a non-GET handler is missing @Audited', () => {
    const handler = makeHandler(POST);
    Reflect.defineMetadata(ROLES_KEY, ['agent'], handler);
    // Intentionally NOT adding @Audited

    const instance = Object.create({ propose: handler }) as Record<string, unknown>;
    const ctrl = { instance, metatype: { name: 'PositionsController' } };

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`exit:${String(_code)}`);
    });
    const messages: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((m) => {
      messages.push(String(m));
      return true;
    });

    try {
      const walker = makeWalker([ctrl]);
      expect(() => walker.onApplicationBootstrap()).toThrow('exit:78');
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    expect(messages.join('')).toContain('on PositionsController#propose missing @Audited()');
  });

  it('does NOT exit when all handlers are properly decorated', () => {
    const handler = makeHandler(POST);
    Reflect.defineMetadata(ROLES_KEY, ['agent'], handler);
    Reflect.defineMetadata(AUDITED_KEY, true, handler);

    const instance = Object.create({ propose: handler }) as Record<string, unknown>;
    const ctrl = { instance, metatype: { name: 'OrdersController' } };

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`exit:${String(_code)}`);
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const walker = makeWalker([ctrl]);
      expect(() => walker.onApplicationBootstrap()).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
