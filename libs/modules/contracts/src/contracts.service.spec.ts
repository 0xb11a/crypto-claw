import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContractsService } from './contracts.service.js';
import type { ContractsRepository } from './contracts.repository.js';

const mockRepo = {
  add: vi.fn(),
  findByAddressChain: vi.fn(),
} as unknown as ContractsRepository;

describe('ContractsService', () => {
  let svc: ContractsService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new ContractsService(mockRepo);
  });

  it('add delegates to repo.add', async () => {
    const dto = { address: '0x1', chain: 'base', json: '{}' };
    const expected = { id: 1, address: '0x1', chain: 'base', safety_data: '{}', checked_at: null };
    (mockRepo.add as ReturnType<typeof vi.fn>).mockResolvedValue(expected);

    const result = await svc.add(dto);
    expect(mockRepo.add).toHaveBeenCalledWith(dto);
    expect(result).toBe(expected);
  });

  it('list delegates to repo.findByAddressChain', async () => {
    const query = { address: '0x1', chain: 'base', limit: 5 };
    (mockRepo.findByAddressChain as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await svc.list(query);
    expect(mockRepo.findByAddressChain).toHaveBeenCalledWith(query);
  });
});
