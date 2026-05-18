import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncPortfolioController } from './sync-portfolio.controller.js';
import type { SystemService } from '../system.service.js';

const mockSvc = {
  enqueueSyncPortfolio: vi.fn(),
} as unknown as SystemService;

describe('SyncPortfolioController', () => {
  let ctrl: SyncPortfolioController;

  beforeEach(() => {
    vi.clearAllMocks();
    ctrl = new SyncPortfolioController(mockSvc);
  });

  it('delegates to svc.enqueueSyncPortfolio in real mode', async () => {
    const dto = { chain: 'base', trigger: 'manual' as const };
    const resp = { ok: true as const, queued: true as const, jobId: '42' };
    (mockSvc.enqueueSyncPortfolio as ReturnType<typeof vi.fn>).mockResolvedValue(resp);
    const result = await ctrl.syncPortfolio(dto);
    expect(mockSvc.enqueueSyncPortfolio).toHaveBeenCalledWith(dto);
    // Use type narrowing to access discriminated union fields.
    expect((result as typeof resp).ok).toBe(true);
    expect((result as typeof resp).jobId).toBe('42');
  });

  it('short-circuits in paper mode returning ok: false', async () => {
    const dto = { chain: 'base' };
    const resp = { ok: false as const, message: 'Portfolio sync skipped in paper mode — DB is sole source of truth' };
    (mockSvc.enqueueSyncPortfolio as ReturnType<typeof vi.fn>).mockResolvedValue(resp);
    const result = await ctrl.syncPortfolio(dto);
    expect((result as typeof resp).ok).toBe(false);
    expect((result as typeof resp).message).toMatch(/paper mode/);
  });
});
