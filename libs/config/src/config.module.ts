import { Module, Global } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { assertConfigValid } from './boot-checks.js';

/**
 * Global NestJS config module.
 *
 * Wraps @nestjs/config with the Zod-validated AppConfig loader.
 * Calling assertConfigValid(process.env) here ensures the process
 * exits cleanly (exit code 78) if the environment is invalid —
 * identical behaviour to the direct boot-check in main.ts.
 *
 * Import once in AppModule; do not import in feature modules.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      // ignoreEnvFile: true ensures @nestjs/config does NOT load .env files
      // from disk. All config comes from process.env (injected by the
      // container runtime via docker-compose env_file or direct env: entries).
      // If we allowed dotenv loading, .env files in the project root (which
      // contain signer keys for local dev) would pollute the managed env and
      // break the boot self-check (SPEC §4 #4).
      ignoreEnvFile: true,
      load: [() => assertConfigValid(process.env)],
    }),
  ],
  exports: [NestConfigModule],
})
export class ConfigModule {}
