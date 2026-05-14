import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { SystemService } from './system.service.js';
import type { SystemRepository } from './system.repository.js';

const mockRepo = {
  seedSafeId: vi.fn(),
  getMeta: vi.fn(),
  setMeta: vi.fn(),
  getCashByChain: vi.fn(),
  getAllCash: vi.fn(),
  setCash: vi.fn(),
  getGas: vi.fn(),
  getSyncStatus: vi.fn(),
} as unknown as SystemRepository;

function makeConfig(paperMode = false): ConfigService {
  return {
    get: (key: string) => {
      if (key === 'PAPER_MODE') return paperMode ? 'true' : 'false';
      if (key === 'SAFE_ID') return 'ci-test';
      return undefined;
    },
  } as unknown as ConfigService;
}

describe('SystemService', () => {
  let svc: SystemService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new SystemService(mockRepo, makeConfig());
  });

  it('getMeta delegates to repo and appends _mode=real', async () => {
    (mockRepo.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({ key: 'k', value: 'v' });
    const result = await svc.getMeta('k');
    expect(mockRepo.getMeta).toHaveBeenCalledWith('k');
    expect(result.value).toBe('v');
    expect(result._mode).toBe('real');
  });

  it('getMeta appends _mode=paper when PAPER_MODE=true', async () => {
    svc = new SystemService(mockRepo, makeConfig(true));
    (mockRepo.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({ key: 'k', value: 'v' });
    const result = await svc.getMeta('k');
    expect(result._mode).toBe('paper');
  });

  it('setMeta delegates to repo', async () => {
    const dto = { key: 'k', value: 'v' };
    (mockRepo.setMeta as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, key: 'k', value: 'v' });
    await svc.setMeta(dto);
    expect(mockRepo.setMeta).toHaveBeenCalledWith(dto);
  });

  it('getCashByChain delegates to repo and appends _mode', async () => {
    (mockRepo.getCashByChain as ReturnType<typeof vi.fn>).mockResolvedValue({ chain: 'base', cash: 100 });
    const result = await svc.getCashByChain('base');
    expect(result.cash).toBe(100);
    expect(result._mode).toBe('real');
  });

  it('getAllCash delegates to repo and appends _mode', async () => {
    (mockRepo.getAllCash as ReturnType<typeof vi.fn>).mockResolvedValue({ base: 100, total: 100 });
    const result = await svc.getAllCash();
    expect(mockRepo.getAllCash).toHaveBeenCalledOnce();
    expect(result['_mode']).toBe('real');
  });

  it('setCash delegates to repo', async () => {
    const dto = { chain: 'base', amount: 500 };
    (mockRepo.setCash as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, chain: 'base', cash: 500 });
    await svc.setCash(dto);
    expect(mockRepo.setCash).toHaveBeenCalledWith(dto);
  });

  it('getGas delegates to repo', async () => {
    (mockRepo.getGas as ReturnType<typeof vi.fn>).mockResolvedValue({
      chain: 'base',
      symbol: 'ETH',
      balance: 0.1,
      price: 3000,
      value_usd: 300,
    });
    await svc.getGas('base');
    expect(mockRepo.getGas).toHaveBeenCalledWith('base');
  });

  it('getSyncStatus delegates to repo', async () => {
    (mockRepo.getSyncStatus as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await svc.getSyncStatus({ chain: 'base' });
    expect(mockRepo.getSyncStatus).toHaveBeenCalledWith({ chain: 'base' });
  });

  it('onApplicationBootstrap seeds safe_id from SAFE_ID config', async () => {
    (mockRepo.seedSafeId as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await svc.onApplicationBootstrap();
    expect(mockRepo.seedSafeId).toHaveBeenCalledWith('ci-test');
  });
});
