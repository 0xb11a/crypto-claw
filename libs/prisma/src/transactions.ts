import type { PrismaClient } from '@prisma/client';
import type { PrismaService } from './prisma.service.js';

/**
 * Helper type for Prisma transactional client.
 *
 * Omits the interactive transaction methods so the callback signature is clean.
 */
export type PrismaTransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Execute a callback inside a Prisma transaction.
 *
 * Wraps PrismaService.$transaction so callers don't need to import PrismaClient
 * directly (SPEC §4 #1 — no @prisma/client imports outside libs/prisma).
 *
 * @param prisma - Injected PrismaService
 * @param fn - Callback receiving the transactional Prisma client
 * @returns The callback's return value
 */
export async function withTransaction<T>(
  prisma: PrismaService,
  fn: (tx: PrismaTransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(fn);
}
