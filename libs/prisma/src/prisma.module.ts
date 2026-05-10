import { Module, Global, DynamicModule } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/**
 * Global Prisma module.
 *
 * Provides and exports PrismaService so any module can inject it without
 * needing to import PrismaModule locally.
 *
 * DATABASE_URL is constructed from AppConfig.DB_PATH by apps/api's AppModule
 * and injected into the process environment before NestFactory.create() is
 * called. PrismaClient reads DATABASE_URL from process.env at instantiation.
 *
 * Pattern: AppModule calls PrismaModule.register(dbPath) which sets
 * process.env.DATABASE_URL = `file:${dbPath}?connection_limit=1` before
 * NestFactory.create() runs — ensuring the single-writer SQLite constraint
 * is honoured (SPEC §3 — SQLite single host, no connection pool needed).
 *
 * Note: process.env assignment happens only in the PrismaModule factory,
 * not in general app code. The ESLint rule allows it here via the config
 * exception pattern.
 */
@Global()
@Module({})
export class PrismaModule {
  /**
   * Configure Prisma with a specific DB path from AppConfig.
   *
   * @param dbPath - Resolved DB path from AppConfig.DB_PATH (e.g. ./data/myfund.db)
   */
  static register(dbPath: string): DynamicModule {
    // Set DATABASE_URL before PrismaService instantiates PrismaClient.
    // Using `file:${path}?connection_limit=1` enforces SQLite single-writer semantics.
    // process.env is allowed here — prisma.module.ts is in the exception file list.
    (process.env as NodeJS.ProcessEnv)['DATABASE_URL'] = `file:${dbPath}?connection_limit=1`;

    // Prevent Prisma from auto-loading .env files at import time.
    // Without this, @prisma/client reads .env from the CWD which could
    // inject SAFE_SIGNER_KEY or SQUADS_SIGNER_KEY into process.env,
    // breaking the signer-key isolation boot-check (SPEC §4 #4, ADR-0010).
    (process.env as NodeJS.ProcessEnv)['PRISMA_DISABLE_DOTENV'] = '1';

    return {
      module: PrismaModule,
      global: true,
      providers: [PrismaService],
      exports: [PrismaService],
    };
  }
}
