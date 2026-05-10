import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaService } from './prisma.service.js';

/**
 * PrismaService unit tests — connect/disconnect lifecycle.
 *
 * Uses an in-memory SQLite database so no files are created on disk.
 */
describe('PrismaService', () => {
  let svc: PrismaService;

  beforeAll(async () => {
    // Point to an isolated in-memory DB for the test
    process.env['DATABASE_URL'] = 'file::memory:?connection_limit=1';
    svc = new PrismaService();
    await svc.onModuleInit();
  });

  afterAll(async () => {
    await svc.onModuleDestroy();
  });

  it('is defined after connect', () => {
    expect(svc).toBeDefined();
  });

  it('can ping the database with $queryRaw', async () => {
    // Simple connectivity check — no tables needed for this query
    // SQLite returns BigInt for integer literals in $queryRaw
    const result = await svc.$queryRaw<Array<{ one: bigint }>>`SELECT 1 as one`;
    expect(Number(result[0].one)).toBe(1);
  });
});
