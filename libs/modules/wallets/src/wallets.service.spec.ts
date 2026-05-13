/**
 * Unit tests for WalletsService (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WalletsService } from './wallets.service.js';
import type { WalletsRepository } from './wallets.repository.js';
import type { TrackedWalletResponseDto } from './dto/tracked-wallet-response.dto.js';

const sampleWallet: TrackedWalletResponseDto = {
  address: '0xabc',
  chain: 'base',
  label: 'Test Whale',
  type: 'smart_money',
  notes: null,
  status: 'scored',
  score: 82,
  score_breakdown: '{"birdeye":80,"zerion":84}',
  source_token: null,
  scored_at: '2026-01-01T00:00:00.000Z',
  score_error: null,
  retry_count: 0,
  source: 'agent',
  last_checked_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

function makeRepo(overrides?: Partial<WalletsRepository>): WalletsRepository {
  return {
    findMany: vi.fn().mockResolvedValue([sampleWallet]),
    findOne: vi.fn().mockResolvedValue(sampleWallet),
    upsertWallet: vi.fn().mockResolvedValue(sampleWallet),
    proposeWallet: vi.fn().mockResolvedValue({ ok: true, address: '0xabc', status: 'proposed', source: 'agent' }),
    findUnscored: vi.fn().mockResolvedValue([sampleWallet]),
    updateScore: vi.fn().mockResolvedValue(sampleWallet),
    remove: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as WalletsRepository;
}

describe('WalletsService', () => {
  let svc: WalletsService;
  let repo: WalletsRepository;

  beforeEach(() => {
    repo = makeRepo();
    svc = new WalletsService(repo);
  });

  it('list() delegates to repo.findMany', async () => {
    const result = await svc.list({});
    expect(repo.findMany).toHaveBeenCalledWith({});
    expect(result).toEqual([sampleWallet]);
  });

  it('getOne() delegates to repo.findOne', async () => {
    const result = await svc.getOne('0xabc', 'base');
    expect(repo.findOne).toHaveBeenCalledWith('0xabc', 'base');
    expect(result).toEqual(sampleWallet);
  });

  it('getOne() propagates NotFoundException', async () => {
    const r = makeRepo({ findOne: vi.fn().mockRejectedValue(new NotFoundException('Wallet not found')) });
    const s = new WalletsService(r);
    await expect(s.getOne('0xmissing', 'base')).rejects.toThrow(NotFoundException);
  });

  it('add() delegates to repo.upsertWallet', async () => {
    const dto = { address: '0xabc', chain: 'base' };
    const result = await svc.add(dto);
    expect(repo.upsertWallet).toHaveBeenCalledWith(dto);
    expect(result).toEqual(sampleWallet);
  });

  it('propose() delegates to repo.proposeWallet', async () => {
    const dto = { address: '0xabc', chain: 'base' };
    const result = await svc.propose(dto);
    expect(repo.proposeWallet).toHaveBeenCalledWith(dto);
    expect(result.status).toBe('proposed');
  });

  it('listUnscored() delegates to repo.findUnscored', async () => {
    const result = await svc.listUnscored(10);
    expect(repo.findUnscored).toHaveBeenCalledWith(10);
    expect(Array.isArray(result)).toBe(true);
  });

  it('updateScore() delegates to repo.updateScore', async () => {
    const dto = { score: 90, status: 'scored' };
    const result = await svc.updateScore('0xabc', 'base', dto);
    expect(repo.updateScore).toHaveBeenCalledWith('0xabc', 'base', dto);
    expect(result.score).toBe(82);
  });

  it('remove() delegates to repo.remove', async () => {
    const result = await svc.remove('0xabc', 'base');
    expect(repo.remove).toHaveBeenCalledWith('0xabc', 'base');
    expect(result.ok).toBe(true);
  });

  it('remove() propagates NotFoundException', async () => {
    const r = makeRepo({ remove: vi.fn().mockRejectedValue(new NotFoundException('Wallet not found')) });
    const s = new WalletsService(r);
    await expect(s.remove('0xmissing', 'base')).rejects.toThrow(NotFoundException);
  });
});
