/**
 * Unit tests for execute-order.processor.ts
 *
 * Tests both the concrete `ExecuteOrderProcessor` (legacy single-queue class)
 * and the `createExecuteOrderProcessor` factory to verify that factory-generated
 * processors inherit the same idempotency and state-machine logic.
 *
 * ADR-0026: ConfigService mock uses per-field gets, not bare-key get<AppConfig>('').
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ExecuteOrderProcessor,
  BaseExecuteOrderProcessor,
  createExecuteOrderProcessor,
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

/**
 * Per-field ConfigService mock (ADR-0026).
 * Returns typed values per field name — no bare-key get<AppConfig>('').
 */
const mockConfigService = {
  get: vi.fn((key: string) => {
    const map: Record<string, string | undefined> = {
      SIGNER_ENV_FILE: '/tmp/test-signer.env',
      NODE_ENV: 'test',
      EXECUTOR_BIN_PATH: undefined,
      PAPER_MODE: 'false',
      EXECUTOR_STUB_MODE: '1',
    };
    return map[key];
  }),
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

/**
 * Create a processor via the factory (simulates the per-Safe dynamic-class path).
 */
function makeFactoryProcessor(queueName: string): BaseExecuteOrderProcessor {
  const ProcessorClass = createExecuteOrderProcessor(queueName);
  return new (ProcessorClass as new (...args: unknown[]) => BaseExecuteOrderProcessor)(
    mockOrdersRepo,
    mockReceiptsService,
    mockAuditService,
    mockConfigService,
  );
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

  it('uses per-field ConfigService.get() — not bare-key get (ADR-0026)', async () => {
    const processor = makeProcessor();
    await processor.process(makeJob('order-001'));

    // Verify that configService.get was called with specific field names, not ''
    const getCalls = (mockConfigService.get as ReturnType<typeof vi.fn>).mock.calls.map((args: unknown[]) => args[0]);
    expect(getCalls).toContain('SIGNER_ENV_FILE');
    expect(getCalls).toContain('NODE_ENV');
    expect(getCalls).not.toContain(''); // bare-key get is forbidden (ADR-0026)
  });
});

// ---------------------------------------------------------------------------
// Factory processor tests (ADR-0024 addendum — per-Safe dynamic classes)
// ---------------------------------------------------------------------------

describe('createExecuteOrderProcessor() factory', () => {
  it('returns a class that processes orders identically to the concrete class', async () => {
    const processor = makeFactoryProcessor('execute-order-base-0xabc');
    await processor.process(makeJob('order-001'));

    expect(mockOrdersRepo.transitionStatus).toHaveBeenCalledWith('order-001', 'executing', 'WORKER');
    expect(mockOrdersRepo.transitionStatus).toHaveBeenCalledWith('order-001', 'executed', 'WORKER');
    expect(mockReceiptsService.create).toHaveBeenCalledOnce();
  });

  it('factory-created processor has idempotency guard for executed orders', async () => {
    mockOrdersRepo.findById.mockResolvedValue({ ...APPROVED_ORDER, status: 'executed' });
    const processor = makeFactoryProcessor('execute-order-base-0xabc');
    await processor.process(makeJob('order-001'));

    expect(spawnExecutor).not.toHaveBeenCalled();
  });

  it('factory-created processor throws NotIdempotentInflightError for executing orders', async () => {
    mockOrdersRepo.findById.mockResolvedValue({ ...APPROVED_ORDER, status: 'executing' });
    const processor = makeFactoryProcessor('execute-order-solana-vault123');
    await expect(processor.process(makeJob('order-001'))).rejects.toThrow(NotIdempotentInflightError);
  });

  it('two factory processors for different queue names are distinct classes', () => {
    const ProcessorA = createExecuteOrderProcessor('execute-order-base-0xabc');
    const ProcessorB = createExecuteOrderProcessor('execute-order-ethereum-0xdef');
    expect(ProcessorA).not.toBe(ProcessorB);
  });
});

// ---------------------------------------------------------------------------
// Queue name resolution tests (ADR-0024 addendum)
// ---------------------------------------------------------------------------

describe('executeOrderQueueName() helper', () => {
  it('produces lowercase safe address in queue name', async () => {
    const { executeOrderQueueName } = await import('../queues/execute-order.queue.js');
    expect(executeOrderQueueName('base', '0xAbCdEf')).toBe('execute-order-base-0xabcdef');
  });

  it('uses - separator (not :)', async () => {
    const { executeOrderQueueName } = await import('../queues/execute-order.queue.js');
    const name = executeOrderQueueName('ethereum', '0x1234');
    expect(name).not.toContain(':');
    expect(name).toContain('-');
  });

  it('format is execute-order-<chain>-<safeAddressLower>', async () => {
    const { executeOrderQueueName } = await import('../queues/execute-order.queue.js');
    expect(executeOrderQueueName('solana', 'SoLaNaVaUlT')).toBe('execute-order-solana-solanavault');
  });
});
