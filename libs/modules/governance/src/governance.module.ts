/**
 * GovernanceModule — worker-side module for the governance-drift job.
 *
 * This module has no HTTP controller and no DB tables. It owns the
 * governance posture entity (the expected vs. observed multisig config)
 * and houses the processor + pure-function drift evaluators.
 *
 * Module placement decision (P3g2 plan §4):
 *   New top-level `libs/modules/governance/` — governance drift is a
 *   safety-domain entity that has no relationship to order state transitions
 *   (it would bloat `orders`). If a future SPEC update adds a
 *   `governance_snapshots` table, this module is the obvious home.
 *
 * Two static factory methods:
 *   - `GovernanceModule` (default) — no-op placeholder (no HTTP surface).
 *   - `GovernanceModule.forWorker()` — registers BullMQ processor +
 *     adapter/service dependencies.
 *
 * PrismaModule and ConfigModule are global; no explicit imports needed.
 */
import { Module, type DynamicModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SafeTxServiceModule } from '@cclaw/adapters-safe-tx-service';
import { SquadsRpcModule } from '@cclaw/adapters-squads-rpc';
import { NotificationsModule } from '@cclaw/notifications';
import { SystemModule } from '@cclaw/system';
import { GovernanceDriftProcessor } from './jobs/governance-drift.processor.js';
import { GOVERNANCE_DRIFT_QUEUE, GOVERNANCE_DRIFT_JOB_OPTIONS } from './jobs/queue-names.js';

@Module({})
export class GovernanceModule {
  /**
   * Worker-side factory — registers the governance-drift BullMQ processor.
   *
   * Does NOT register HTTP controllers (this module has none).
   * Imports SafeTxServiceModule, SquadsRpcModule, NotificationsModule, and
   * SystemModule so the processor can resolve all its dependencies.
   *
   * Queue registration lives here (not in apps/worker/src/app.module.ts) so
   * the `@Processor(GOVERNANCE_DRIFT_QUEUE)` in GovernanceDriftProcessor
   * resolves correctly within this module's context. NestJS BullMQ's
   * `registerQueue` is module-scoped; the Queue provider must be visible in
   * the same module that declares the consumer processor.
   */
  static forWorker(): DynamicModule {
    return {
      module: GovernanceModule,
      imports: [
        BullModule.registerQueue({
          name: GOVERNANCE_DRIFT_QUEUE,
          defaultJobOptions: { ...GOVERNANCE_DRIFT_JOB_OPTIONS },
        }),
        SafeTxServiceModule,
        SquadsRpcModule,
        NotificationsModule,
        SystemModule,
      ],
      providers: [GovernanceDriftProcessor],
    };
  }
}
