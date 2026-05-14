import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalysisCacheService } from './analysis-cache.service.js';
import type { AnalysisCacheRepository } from './analysis-cache.repository.js';

const mockRepo = {
  upsert: vi.fn(),
  findNonExpired: vi.fn(),
  findByAddressChain: vi.fn(),
  deleteExpiredBatch: vi.fn(),
} as unknown as AnalysisCacheRepository;

describe('AnalysisCacheService', () => {
  let svc: AnalysisCacheService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new AnalysisCacheService(mockRepo);
  });

  it('upsert delegates to repo.upsert', async () => {
    const dto = { address: '0x1', chain: 'base', verdict: 'buy' };
    const expected = { address: '0x1', chain: 'base', verdict: 'buy' };
    (mockRepo.upsert as ReturnType<typeof vi.fn>).mockResolvedValue(expected);

    const result = await svc.upsert(dto);
    expect(mockRepo.upsert).toHaveBeenCalledWith(dto);
    expect(result).toBe(expected);
  });

  it('listNonExpired delegates to repo.findNonExpired', async () => {
    const query = { limit: 10 };
    (mockRepo.findNonExpired as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await svc.listNonExpired(query);
    expect(mockRepo.findNonExpired).toHaveBeenCalledWith(query);
  });

  it('checkToken delegates to repo.findByAddressChain', async () => {
    const query = { address: '0x1', chain: 'base' };
    (mockRepo.findByAddressChain as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await svc.checkToken(query);
    expect(mockRepo.findByAddressChain).toHaveBeenCalledWith(query);
    expect(result).toBeNull();
  });

  it('clearExpired delegates to repo.deleteExpiredBatch', async () => {
    (mockRepo.deleteExpiredBatch as ReturnType<typeof vi.fn>).mockResolvedValue(5);

    const count = await svc.clearExpired();
    expect(mockRepo.deleteExpiredBatch).toHaveBeenCalledOnce();
    expect(count).toBe(5);
  });
});
