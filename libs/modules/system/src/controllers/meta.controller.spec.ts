import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetaController } from './meta.controller.js';
import type { SystemService } from '../system.service.js';

const mockSvc = {
  getMeta: vi.fn(),
  setMeta: vi.fn(),
} as unknown as SystemService;

describe('MetaController', () => {
  let ctrl: MetaController;

  beforeEach(() => {
    vi.clearAllMocks();
    ctrl = new MetaController(mockSvc);
  });

  it('getMeta delegates to svc.getMeta', async () => {
    (mockSvc.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({ key: 'k', value: 'v' });
    const result = await ctrl.getMeta({ key: 'k' });
    expect(mockSvc.getMeta).toHaveBeenCalledWith('k');
    expect(result.value).toBe('v');
  });

  it('setMeta delegates to svc.setMeta', async () => {
    const dto = { key: 'k', value: 'v' };
    (mockSvc.setMeta as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, key: 'k', value: 'v' });
    const result = await ctrl.setMeta(dto);
    expect(result.ok).toBe(true);
  });
});
