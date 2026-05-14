import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContractsController } from './contracts.controller.js';
import type { ContractsService } from './contracts.service.js';

const fakeSnapshot = {
  id: 1,
  address: '0xcontract',
  chain: 'base',
  safety_data: '{"is_honeypot":false}',
  checked_at: '2026-05-14 10:00:00',
};

const mockSvc = {
  list: vi.fn(),
  add: vi.fn(),
} as unknown as ContractsService;

describe('ContractsController', () => {
  let ctrl: ContractsController;

  beforeEach(() => {
    vi.clearAllMocks();
    ctrl = new ContractsController(mockSvc);
  });

  describe('list()', () => {
    it('returns array from service', async () => {
      (mockSvc.list as ReturnType<typeof vi.fn>).mockResolvedValue([fakeSnapshot]);
      const result = await ctrl.list({ address: '0xcontract', chain: 'base', limit: 5 });
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(fakeSnapshot);
    });
  });

  describe('add()', () => {
    it('returns the created snapshot', async () => {
      (mockSvc.add as ReturnType<typeof vi.fn>).mockResolvedValue(fakeSnapshot);
      const dto = { address: '0xcontract', chain: 'base', json: '{"is_honeypot":false}' };
      const result = await ctrl.add(dto);
      expect(mockSvc.add).toHaveBeenCalledWith(dto);
      expect(result).toBe(fakeSnapshot);
    });
  });
});
