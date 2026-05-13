/**
 * Unit tests for WatchlistService (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WatchlistService } from './watchlist.service.js';
import type { WatchlistRepository } from './watchlist.repository.js';
import type { WatchlistResponseDto } from './dto/watchlist-response.dto.js';

const sampleEntry: WatchlistResponseDto = {
  id: 'watch-1',
  symbol: 'ETH',
  address: '0xtoken',
  chain: 'base',
  target_entry: 2000,
  current_price: 2100,
  analysis_score: 80,
  risk_score: 20,
  narrative: null,
  reason: null,
  expires_at: null,
  status: 'watching',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function makeRepo(overrides?: Partial<WatchlistRepository>): WatchlistRepository {
  return {
    findMany: vi.fn().mockResolvedValue([sampleEntry]),
    findById: vi.fn().mockResolvedValue(sampleEntry),
    create: vi.fn().mockResolvedValue(sampleEntry),
    update: vi.fn().mockResolvedValue(sampleEntry),
    softDelete: vi.fn().mockResolvedValue({ ok: true, id: 'watch-1' }),
    ...overrides,
  } as unknown as WatchlistRepository;
}

describe('WatchlistService', () => {
  let svc: WatchlistService;
  let repo: WatchlistRepository;

  beforeEach(() => {
    repo = makeRepo();
    svc = new WatchlistService(repo);
  });

  it('list() delegates to repo.findMany', async () => {
    const result = await svc.list({ status: 'watching' });
    expect(repo.findMany).toHaveBeenCalledWith({ status: 'watching' });
    expect(result).toEqual([sampleEntry]);
  });

  it('getById() delegates to repo.findById', async () => {
    const result = await svc.getById('watch-1');
    expect(repo.findById).toHaveBeenCalledWith('watch-1');
    expect(result).toEqual(sampleEntry);
  });

  it('getById() propagates NotFoundException', async () => {
    const r = makeRepo({ findById: vi.fn().mockRejectedValue(new NotFoundException()) });
    const s = new WatchlistService(r);
    await expect(s.getById('missing')).rejects.toThrow(NotFoundException);
  });

  it('add() delegates to repo.create', async () => {
    const dto = { id: 'watch-1', symbol: 'ETH', address: '0xtoken', chain: 'base' };
    const result = await svc.add(dto);
    expect(repo.create).toHaveBeenCalledWith(dto);
    expect(result.id).toBe('watch-1');
  });

  it('update() delegates to repo.update', async () => {
    const dto = { current_price: 2200 };
    const result = await svc.update('watch-1', dto);
    expect(repo.update).toHaveBeenCalledWith('watch-1', dto);
    expect(result).toEqual(sampleEntry);
  });

  it('softDelete() delegates to repo.softDelete', async () => {
    const result = await svc.softDelete('watch-1');
    expect(repo.softDelete).toHaveBeenCalledWith('watch-1');
    expect(result.ok).toBe(true);
  });
});
