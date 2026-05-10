import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * NestJS-managed Prisma service.
 *
 * Extends PrismaClient to participate in the Nest lifecycle:
 * - Calls $connect() on module init.
 * - Calls $disconnect() on module destroy.
 *
 * DATABASE_URL is injected via process.env at PrismaClient construction;
 * it is set by PrismaModule.forRoot() before this service is instantiated
 * (SPEC §4 #6 — config validated at boot; DB_PATH comes from AppConfig).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
