/**
 * Unit tests for execute-order.processor.ts
 *
 * Uses mocked dependencies to test idempotency logic and status transitions
 * without spawning real child processes or hitting real DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ExecuteOrderProcessor,
  type ExecuteOrderJobData,
  NotIdempotentInflightError,
} from './execute-order.processor.js';
import type { Job } from 'bullmq';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockOrdersRepo = {
  findById: vi.fn(),
  transitionStatus: vi.fn(),
};

const mockReceiptsService = {
  create: vi.fn(),
};

const mockAuditService = {
  write: vi.fn(),
};

const mockConfigService = {
  get: vi.fn(() => ({
    SIGNER_ENV_FILE: '/tmp/test-signer.env',
    NODE_ENV: 'test',
    EXECUTOR_BIN_PATH: undefined,
  })),
};

// Mock libs/execution functions
vi.mock('@cclaw/execution', () => ({
  loadSignerEnv: vi.fn(() => ({ SAFE_SIGNER_KEY: 'test-key', SQUADS_SIGNER_KEY: '' })),
  spawnExecutor: vi.fn(),
  getExecutorPath: vi.fn(() => '/fake/executor/dist/main.js'),
}));

import { spawnExecutor } from '@cclaw/execution';

function makeProcessor(): ExecuteOrderProcessor {
  const ProcessorClass = ExecuteOrderProcessor as new (...args: unknown[]) => ExecuteOrderProcessor;
  return new ProcessorClass(mockOrdersRepo, mockReceiptsService, mockAuditService, mockConfigService);
}

function makeJob(orderId: string): Job<ExecuteOrderJobData> {
  return {
    id: 'job-001',
    data: { orderId },
  } as unknown as Job<ExecuteOrderJobData>;
}

const APPROVED_ORDER = {
  id: 'order-001',
  action: 'buy',
  symbol: 'ETH',
  address: '0x0001',
  chain: 'base',
  amount: '100',
  status: 'approved',
  entry_price: 2000,
  tier: 'conviction',
  stop_loss: undefined,
};

const SUCCESS_RECEIPT = {
  status: 'executed' as const,
  tx_hash: '0x' + 'a'.repeat(64),
  block_number: 1000000,
  gas_used: 50000,
  actual_amount_in: '100',
  actual_amount_out: 0.05,
  slippage_bps: 50,
  executed_at: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockOrdersRepo.findById.mockResolvedValue(APPROVED_ORDER);
  mockOrdersRepo.transitionStatus.mockResolvedValue({ ...APPROVED_ORDER });
  mockReceiptsService.create.mockResolvedValue({ id: 'receipt-001' });
  mockAuditService.write.mockResolvedValue(undefined);
  (spawnExecutor as ReturnType<typeof vi.fn>).mockResolvedValue({
    exitCode: 0,
    receipt: SUCCESS_RECEIPT,
    stderr: '',
    latencyMs: 100,
  });
});

describe('ExecuteOrderProcessor.process()', () => {
  it('processes approved order successfully', async () => {
    const processor = makeProcessor();
    await processor.process(makeJob('order-001'));

    expect(mockOrdersRepo.transitionStatus).toHaveBeenCalledWith('order-001', 'executing', 'WORKER');
    expect(mockOrdersRepo.transitionStatus).toHaveBeenCalledWith('order-001', 'executed', 'WORKER');
    expect(mockReceiptsService.create).toHaveBeenCalledOnce();
    expect(mockAuditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'worker:execute-order:order-001',
        status: 200,
        identity: 'WORKER',
        role: 'agent',
        method: 'JOB',
      }),
    );
  });

  it('is idempotent for already executed orders', async () => {
    mockOrdersRepo.findById.mockResolvedValue({ ...APPROVED_ORDER, status: 'executed' });
    const processor = makeProcessor();
    await processor.process(makeJob('order-001'));

    expect(spawnExecutor).not.toHaveBeenCalled();
    expect(mockReceiptsService.create).not.toHaveBeenCalled();
  });

  it('is idempotent for already failed orders', async () => {
    mockOrdersRepo.findById.mockResolvedValue({ ...APPROVED_ORDER, status: 'failed' });
    const processor = makeProcessor();
    await processor.process(makeJob('order-001'));

    expect(spawnExecutor).not.toHaveBeenCalled();
  });

  it('throws NotIdempotentInflightError for executing orders', async () => {
    mockOrdersRepo.findById.mockResolvedValue({ ...APPROVED_ORDER, status: 'executing' });
    const processor = makeProcessor();
    await expect(processor.process(makeJob('order-001'))).rejects.toThrow(NotIdempotentInflightError);
  });

  it('transitions to failed and re-throws when spawn fails', async () => {
    (spawnExecutor as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('spawn failed'));
    const processor = makeProcessor();
    await expect(processor.process(makeJob('order-001'))).rejects.toThrow('spawn failed');

    expect(mockOrdersRepo.transitionStatus).toHaveBeenCalledWith('order-001', 'failed', 'WORKER', expect.any(String));
    expect(mockAuditService.write).toHaveBeenCalledWith(expect.objectContaining({ status: 500 }));
  });

  it('transitions to failed when receipt shows failure', async () => {
    (spawnExecutor as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 1,
      receipt: { status: 'failed', error: 'not_yet_implemented', error_kind: 'not_yet_implemented_real_mode' },
      stderr: '',
      latencyMs: 50,
    });
    const processor = makeProcessor();
    await expect(processor.process(makeJob('order-001'))).rejects.toThrow();

    expect(mockOrdersRepo.transitionStatus).toHaveBeenCalledWith(
      'order-001',
      'failed',
      'WORKER',
      'not_yet_implemented',
    );
    expect(mockAuditService.write).toHaveBeenCalledWith(expect.objectContaining({ status: 500 }));
  });

  it('writes audit row with worker: prefix path', async () => {
    const processor = makeProcessor();
    await processor.process(makeJob('order-001'));

    const auditCall = (mockAuditService.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditCall.path).toBe('worker:execute-order:order-001');
  });
});
