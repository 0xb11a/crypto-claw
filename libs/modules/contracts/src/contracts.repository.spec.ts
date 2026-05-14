import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContractsRepository } from './contracts.repository.js';
import type { PrismaService } from '@cclaw/prisma';

const mockCreate = vi.fn();
const mockFindMany = vi.fn();

const mockPrisma = {
  contractSnapshot: {
    create: mockCreate,
    findMany: mockFindMany,
  },
} as unknown as PrismaService;

const makeRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  address: '0xcontract',
  chain: 'base',
  safetyData: '{"is_honeypot":false}',
  checkedAt: '2026-05-14 10:00:00',
  ...overrides,
});

describe('ContractsRepository', () => {
  let repo: ContractsRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new ContractsRepository(mockPrisma);
  });

  describe('add()', () => {
    it('creates snapshot without checkedAt and maps the row', async () => {
      const row = makeRow();
      mockCreate.mockResolvedValue(row);

      const result = await repo.add({
        address: '0xcontract',
        chain: 'base',
        json: '{"is_honeypot":false}',
      });

      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          address: '0xcontract',
          chain: 'base',
          safetyData: '{"is_honeypot":false}',
        },
      });
      // checkedAt NOT passed — SQLite DEFAULT must fire
      const callData = mockCreate.mock.calls[0][0].data as Record<string, unknown>;
      expect(callData['checkedAt']).toBeUndefined();

      expect(result.safety_data).toBe('{"is_honeypot":false}');
      expect(result.id).toBe(1);
    });
  });

  describe('findByAddressChain()', () => {
    it('queries with correct where + orderBy + limit and maps rows', async () => {
      const rows = [makeRow({ id: 2 }), makeRow({ id: 1 })];
      mockFindMany.mockResolvedValue(rows);

      const result = await repo.findByAddressChain({
        address: '0xcontract',
        chain: 'base',
        limit: 5,
      });

      expect(mockFindMany).toHaveBeenCalledWith({
        where: { address: '0xcontract', chain: 'base' },
        orderBy: { checkedAt: 'desc' },
        take: 5,
      });
      expect(result).toHaveLength(2);
      expect(result[0]!.id).toBe(2);
    });

    it('defaults limit to 5', async () => {
      mockFindMany.mockResolvedValue([]);
      await repo.findByAddressChain({ address: '0xcontract', chain: 'base' });

      const call = mockFindMany.mock.calls[0][0] as { take: number };
      expect(call.take).toBe(5);
    });

    it('caps limit at 100', async () => {
      mockFindMany.mockResolvedValue([]);
      await repo.findByAddressChain({ address: '0xcontract', chain: 'base', limit: 999 });

      const call = mockFindMany.mock.calls[0][0] as { take: number };
      expect(call.take).toBe(100);
    });
  });
});
