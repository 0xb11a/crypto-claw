import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalysisCacheController } from './analysis-cache.controller.js';
import type { AnalysisCacheService } from './analysis-cache.service.js';
import { NotFoundException } from '@nestjs/common';

const fakeEntry = {
  address: '0xtoken',
  chain: 'base',
  symbol: 'TKN',
  analysis_score: 75,
  risk_score: 30,
  verdict: 'buy',
  tier: 'moonshot',
  reasoning: null,
  expires_at: '2099-01-01 00:00:00',
  created_at: '2026-05-14 10:00:00',
};

const mockSvc = {
  listNonExpired: vi.fn(),
  upsert: vi.fn(),
  checkToken: vi.fn(),
  clearExpired: vi.fn(),
} as unknown as AnalysisCacheService;

describe('AnalysisCacheController', () => {
  let ctrl: AnalysisCacheController;

  beforeEach(() => {
    vi.clearAllMocks();
    ctrl = new AnalysisCacheController(mockSvc);
  });

  describe('list()', () => {
    it('returns array from service', async () => {
      (mockSvc.listNonExpired as ReturnType<typeof vi.fn>).mockResolvedValue([fakeEntry]);
      const result = await ctrl.list({ limit: 10 });
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(fakeEntry);
    });
  });

  describe('upsert()', () => {
    it('returns the upserted entry', async () => {
      (mockSvc.upsert as ReturnType<typeof vi.fn>).mockResolvedValue(fakeEntry);
      const dto = { address: '0xtoken', chain: 'base', verdict: 'buy' };
      const result = await ctrl.upsert(dto as Parameters<typeof ctrl.upsert>[0]);
      expect(mockSvc.upsert).toHaveBeenCalledWith(dto);
      expect(result).toBe(fakeEntry);
    });
  });

  describe('check()', () => {
    it('returns entry when found', async () => {
      (mockSvc.checkToken as ReturnType<typeof vi.fn>).mockResolvedValue(fakeEntry);
      const result = await ctrl.check({ address: '0xtoken', chain: 'base' });
      expect(result).toBe(fakeEntry);
    });

    it('throws NotFoundException when not found', async () => {
      (mockSvc.checkToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(ctrl.check({ address: '0xmissing', chain: 'base' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('clearExpired()', () => {
    it('returns ok and deleted count', async () => {
      (mockSvc.clearExpired as ReturnType<typeof vi.fn>).mockResolvedValue(3);
      const result = await ctrl.clearExpired();
      expect(result).toEqual({ ok: true, deleted: 3 });
    });
  });
});
