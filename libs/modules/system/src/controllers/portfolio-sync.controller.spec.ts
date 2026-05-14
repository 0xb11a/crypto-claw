import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortfolioSyncController } from './portfolio-sync.controller.js';
import type { SystemService } from '../system.service.js';

const mockSvc = {
  getSyncStatus: vi.fn(),
} as unknown as SystemService;

describe('PortfolioSyncController', () => {
  let ctrl: PortfolioSyncController;

  beforeEach(() => {
    vi.clearAllMocks();
    ctrl = new PortfolioSyncController(mockSvc);
  });

  it('getSyncStatus delegates to svc with query', async () => {
    const rows = [
      {
        id: 1,
        chain: 'base',
        provider: 'debank',
        trigger: 'manual',
        status: 'success',
        positions_synced: 3,
        positions_closed: 0,
        positions_discovered: 1,
        error: null,
        synced_at: '2026-05-14 10:00:00',
      },
    ];
    (mockSvc.getSyncStatus as ReturnType<typeof vi.fn>).mockResolvedValue(rows);

    const result = await ctrl.getSyncStatus({ chain: 'base', limit: 5 });
    expect(mockSvc.getSyncStatus).toHaveBeenCalledWith({ chain: 'base', limit: 5 });
    expect(result).toBe(rows);
  });

  it('returns empty array when no rows', async () => {
    (mockSvc.getSyncStatus as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const result = await ctrl.getSyncStatus({});
    expect(result).toEqual([]);
  });
});
