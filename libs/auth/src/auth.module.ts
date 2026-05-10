import { Module, Global } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { BearerAuthGuard } from './bearer-auth.guard.js';
import { RolesGuard } from './roles.guard.js';
import { IdentityGuard } from './identity.guard.js';
import { IdentityRegistry } from './identity-registry.js';
import { RouteWalkerService } from './route-walker.service.js';
import { parseEnv, type AppConfig } from '@cclaw/config';

/**
 * Global authentication and authorization module (SPEC §9.1–§9.3, ADR-0009).
 *
 * Provides:
 * - IdentityRegistry (built from AppConfig)
 * - BearerAuthGuard (APP_GUARD — runs on every request)
 * - RolesGuard (APP_GUARD — runs on every request after BearerAuthGuard)
 * - IdentityGuard (APP_GUARD — no-op shim until P7)
 * - RouteWalkerService (boot-time default-deny enforcement)
 *
 * Import once in AppModule. Do not import in feature modules.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    // Build IdentityRegistry from the validated AppConfig.
    // We use parseEnv directly here since the ConfigService's get('') pattern
    // does not reliably return the full config object when using flat load functions.
    // This is equivalent to what app.module.ts does — the config is already validated
    // by assertConfigValid at module import time, so parseEnv here is just reading
    // the already-set env vars.
    {
      provide: IdentityRegistry,
      inject: [ConfigService],
      // ConfigService is injected but the config is read via parseEnv(process.env)
      // for reliability — configSvc.get('') does not return the full config when
      // using flat load functions. process.env is allowed here (exception file list).
      useFactory: (_configSvc: ConfigService) => {
        const config: AppConfig = parseEnv(process.env);
        return new IdentityRegistry(config);
      },
    },

    // Global guards — applied to every route in the order they are listed
    { provide: APP_GUARD, useClass: BearerAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: IdentityGuard },

    // Boot-time route walker
    RouteWalkerService,
  ],
  exports: [IdentityRegistry, RouteWalkerService],
})
export class AuthModule {}
