import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ChainsController } from './chains.controller.js';
import type { SystemService } from '../system.service.js';

const mockSvc = {
  getChains: vi.fn(),
  getChainConfig: vi.fn(),
} as unknown as SystemService;

describe('ChainsController', () => {
  let ctrl: ChainsController;

  beforeEach(() => {
    vi.clearAllMocks();
    ctrl = new ChainsController(mockSvc);
  });

  it('getChains delegates to svc.getChains', () => {
    const resp = { active: ['base'], all: ['base', 'ethereum', 'solana'] };
    (mockSvc.getChains as ReturnType<typeof vi.fn>).mockReturnValue(resp);
    const result = ctrl.getChains();
    expect(result.active).toEqual(['base']);
    expect(result.all).toContain('solana');
  });

  it('getChainConfig delegates to svc.getChainConfig', () => {
    const resp = {
      name: 'base',
      type: 'evm',
      chainId: '8453',
      dex: '1inch',
      nativeToken: { symbol: 'ETH', decimals: 18 },
    };
    (mockSvc.getChainConfig as ReturnType<typeof vi.fn>).mockReturnValue(resp);
    const result = ctrl.getChainConfig('base');
    expect(result.name).toBe('base');
    expect(mockSvc.getChainConfig).toHaveBeenCalledWith('base');
  });

  it('getChainConfig throws NotFoundException for unknown chain', () => {
    (mockSvc.getChainConfig as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('Unknown chain: notreal');
    });
    expect(() => ctrl.getChainConfig('notreal')).toThrow(NotFoundException);
  });
});
