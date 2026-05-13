/**
 * Unit tests for WatchlistController (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WatchlistController } from './watchlist.controller.js';
import type { WatchlistService } from './watchlist.service.js';
import type { WatchlistResponseDto } from './dto/watchlist-response.dto.js';

const sampleEntry: WatchlistResponseDto = {
  id: 'watch-1',
  symbol: 'ETH',
  address: '0xtoken',
  chain: 'base',
  target_entry: null,
  current_price: null,
  analysis_score: null,
  risk_score: null,
  narrative: null,
  reason: null,
  expires_at: null,
  status: 'watching',
  created_at: null,
  updated_at: null,
};

function makeSvc(overrides?: Partial<WatchlistService>): WatchlistService {
  return {
    list: vi.fn().mockResolvedValue([sampleEntry]),
    getById: vi.fn().mockResolvedValue(sampleEntry),
    add: vi.fn().mockResolvedValue(sampleEntry),
    update: vi.fn().mockResolvedValue(sampleEntry),
    softDelete: vi.fn().mockResolvedValue({ ok: true, id: 'watch-1' }),
    ...overrides,
  } as unknown as WatchlistService;
}

describe('WatchlistController', () => {
  let ctrl: WatchlistController;
  let svc: WatchlistService;

  beforeEach(() => {
    svc = makeSvc();
    ctrl = new WatchlistController(svc);
  });

  it('list() delegates to svc.list', async () => {
    const result = await ctrl.list({});
    expect(svc.list).toHaveBeenCalledWith({});
    expect(result).toEqual([sampleEntry]);
  });

  it('getById() delegates to svc.getById', async () => {
    const result = await ctrl.getById('watch-1');
    expect(svc.getById).toHaveBeenCalledWith('watch-1');
    expect(result).toEqual(sampleEntry);
  });

  it('add() delegates to svc.add', async () => {
    const dto = { id: 'watch-1', symbol: 'ETH', address: '0xtoken', chain: 'base' };
    const result = await ctrl.add(dto);
    expect(svc.add).toHaveBeenCalledWith(dto);
    expect(result.id).toBe('watch-1');
  });

  it('update() delegates to svc.update', async () => {
    const dto = { current_price: 2200 };
    const result = await ctrl.update('watch-1', dto);
    expect(svc.update).toHaveBeenCalledWith('watch-1', dto);
    expect(result).toEqual(sampleEntry);
  });

  it('remove() delegates to svc.softDelete', async () => {
    const result = await ctrl.remove('watch-1');
    expect(svc.softDelete).toHaveBeenCalledWith('watch-1');
    expect(result.ok).toBe(true);
  });

  it('all handler methods are present', () => {
    expect(typeof ctrl.list).toBe('function');
    expect(typeof ctrl.getById).toBe('function');
    expect(typeof ctrl.add).toBe('function');
    expect(typeof ctrl.update).toBe('function');
    expect(typeof ctrl.remove).toBe('function');
  });
});
