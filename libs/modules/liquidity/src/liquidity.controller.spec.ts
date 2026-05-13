/**
 * Unit tests for LiquidityController (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LiquidityController } from './liquidity.controller.js';
import type { LiquidityService } from './liquidity.service.js';
import type { LiquiditySnapshotResponseDto } from './dto/liquidity-snapshot-response.dto.js';

const sampleSnapshot: LiquiditySnapshotResponseDto = {
  id: 1,
  address: '0xpool',
  chain: 'base',
  liquidity_usd: 50000.0,
  checked_at: '2026-01-01T00:00:00.000Z',
};

function makeSvc(overrides?: Partial<LiquidityService>): LiquidityService {
  return {
    list: vi.fn().mockResolvedValue([sampleSnapshot]),
    add: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as LiquidityService;
}

describe('LiquidityController', () => {
  let ctrl: LiquidityController;
  let svc: LiquidityService;

  beforeEach(() => {
    svc = makeSvc();
    ctrl = new LiquidityController(svc);
  });

  it('list() delegates to svc.list', async () => {
    const query = { address: '0xpool', chain: 'base' };
    const result = await ctrl.list(query);
    expect(svc.list).toHaveBeenCalledWith(query);
    expect(result).toEqual([sampleSnapshot]);
  });

  it('add() delegates to svc.add', async () => {
    const dto = { address: '0xpool', chain: 'base', liquidity_usd: 50000 };
    const result = await ctrl.add(dto);
    expect(svc.add).toHaveBeenCalledWith(dto);
    expect(result.ok).toBe(true);
  });
});
