/**
 * Unit tests for LiquidityService (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LiquidityService } from './liquidity.service.js';
import type { LiquidityRepository } from './liquidity.repository.js';
import type { LiquiditySnapshotResponseDto } from './dto/liquidity-snapshot-response.dto.js';

const sampleSnapshot: LiquiditySnapshotResponseDto = {
  id: 1,
  address: '0xpool',
  chain: 'base',
  liquidity_usd: 50000.0,
  checked_at: '2026-01-01T00:00:00.000Z',
};

function makeRepo(overrides?: Partial<LiquidityRepository>): LiquidityRepository {
  return {
    findMany: vi.fn().mockResolvedValue([sampleSnapshot]),
    create: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as LiquidityRepository;
}

describe('LiquidityService', () => {
  let svc: LiquidityService;
  let repo: LiquidityRepository;

  beforeEach(() => {
    repo = makeRepo();
    svc = new LiquidityService(repo);
  });

  it('list() delegates to repo.findMany', async () => {
    const result = await svc.list({ address: '0xpool', chain: 'base' });
    expect(repo.findMany).toHaveBeenCalledWith({ address: '0xpool', chain: 'base' });
    expect(result).toEqual([sampleSnapshot]);
  });

  it('add() delegates to repo.create', async () => {
    const dto = { address: '0xpool', chain: 'base', liquidity_usd: 50000 };
    const result = await svc.add(dto);
    expect(repo.create).toHaveBeenCalledWith(dto);
    expect(result.ok).toBe(true);
  });
});
