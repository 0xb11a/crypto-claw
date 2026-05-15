/**
 * Worker AppModule DI smoke test (SPEC §14, DoD §A, §E).
 *
 * Verifies that:
 *   1. WALLET_HARVEST_QUEUE is registered in AppModule with the correct
 *      BullMQ retry policy: attempts:2, fixed backoff 60_000 ms (P3g1 [OPEN-4]).
 *   2. The WALLET_HARVEST_JOB_OPTIONS constant from wallet-harvest.queue.ts
 *      declares the expected policy.
 *   3. HarvestProcessor class is importable from the expected location.
 *   4. The WALLET_HARVEST_QUEUE constant value matches what app.module.ts uses.
 *   5. (PR-B) WALLET_SCORING_QUEUE constant parity and WALLET_SCORING_JOB_OPTIONS
 *      retry policy match harvest's policy (P3g1 [OPEN-4]).
 *   6. (PR-B) ScoreWalletsProcessor class is importable from the expected location.
 *
 * NOTE: Full NestJS `Test.createTestingModule` bootstrap is intentionally NOT
 * used here. Bootstrapping AppModule requires a live Redis connection and a
 * compiled Prisma client pointed at a real DB. Those checks live in:
 *   - apps/worker/src/main.spec.ts — boot-defense integration (built artifact)
 *   - tests/integration/boot-defenses.spec.ts — multi-app boot defenses
 *
 * This spec covers the *static* DI contract: queue name parity and retry
 * policy invariants that can be verified without a running process.
 *
 * SPEC §4 — boot self-checks (signer-key isolation, config validation).
 * SPEC §8 — background job retry policy: attempts:2, 60 s fixed backoff.
 * DoD §E — backoff/retry policy asserted.
 */

import { describe, it, expect } from 'vitest';
import { WALLET_HARVEST_QUEUE, WALLET_HARVEST_JOB_OPTIONS } from './queues/wallet-harvest.queue.js';
import { WALLET_SCORING_QUEUE, WALLET_SCORING_JOB_OPTIONS } from './queues/wallet-scoring.queue.js';
import { WALLET_ACTIVITY_QUEUE, WALLET_ACTIVITY_JOB_OPTIONS } from './queues/wallet-activity.queue.js';
import { GOVERNANCE_DRIFT_QUEUE, GOVERNANCE_DRIFT_JOB_OPTIONS } from './queues/governance-drift.queue.js';
import { MULTISIG_TRACKING_QUEUE, MULTISIG_TRACKING_JOB_OPTIONS } from './queues/multisig-tracking.queue.js';
import { POSITION_RECONCILE_QUEUE, POSITION_RECONCILE_JOB_OPTIONS } from './queues/position-reconcile.queue.js';
import { PORTFOLIO_REPORT_QUEUE, PORTFOLIO_REPORT_JOB_OPTIONS } from './queues/portfolio-report.queue.js';
import {
  WALLET_HARVEST_QUEUE as DOMAIN_HARVEST_QUEUE,
  WALLET_SCORING_QUEUE as DOMAIN_SCORING_QUEUE,
  WALLET_ACTIVITY_QUEUE as DOMAIN_ACTIVITY_QUEUE,
} from '@cclaw/wallets';
import { GOVERNANCE_DRIFT_QUEUE as DOMAIN_GOVERNANCE_DRIFT_QUEUE } from '@cclaw/governance';
import { MULTISIG_TRACKING_QUEUE as DOMAIN_MULTISIG_TRACKING_QUEUE } from '@cclaw/orders';
import { POSITION_RECONCILE_QUEUE as DOMAIN_POSITION_RECONCILE_QUEUE } from '@cclaw/positions';
import { PORTFOLIO_REPORT_QUEUE as DOMAIN_PORTFOLIO_REPORT_QUEUE } from '@cclaw/system';
import { HarvestProcessor } from '../../../libs/modules/wallets/src/jobs/harvest.processor.js';
import { ScoreWalletsProcessor } from '../../../libs/modules/wallets/src/jobs/score-wallets.processor.js';
import { ActivityWalletsProcessor } from '../../../libs/modules/wallets/src/jobs/activity-wallets.processor.js';
import { GovernanceDriftProcessor } from '../../../libs/modules/governance/src/jobs/governance-drift.processor.js';
import { MultisigTrackerProcessor } from '../../../libs/modules/orders/src/jobs/multisig-tracker.processor.js';
import { PositionReconcileProcessor } from '../../../libs/modules/positions/src/jobs/position-reconcile.processor.js';
import { PortfolioReportProcessor } from '../../../libs/modules/system/src/jobs/portfolio-report.processor.js';

describe('Worker AppModule — static DI contract verification', () => {
  // -------------------------------------------------------------------------
  // Queue name parity: scheduler and worker must import from the same source
  // -------------------------------------------------------------------------

  describe('WALLET_HARVEST_QUEUE constant', () => {
    it('worker re-export equals the domain canonical value', () => {
      // Both the scheduler and worker re-export from @cclaw/wallets.
      // If they ever diverge, the scheduler enqueues to a queue the worker
      // never processes — this test catches that before runtime.
      expect(WALLET_HARVEST_QUEUE).toBe(DOMAIN_HARVEST_QUEUE);
    });

    it('equals "wallet-harvest"', () => {
      expect(WALLET_HARVEST_QUEUE).toBe('wallet-harvest');
    });
  });

  // -------------------------------------------------------------------------
  // PR-B: WALLET_SCORING_QUEUE parity
  // -------------------------------------------------------------------------

  describe('WALLET_SCORING_QUEUE constant (PR-B)', () => {
    it('worker re-export equals the domain canonical value', () => {
      expect(WALLET_SCORING_QUEUE).toBe(DOMAIN_SCORING_QUEUE);
    });

    it('equals "wallet-scoring"', () => {
      expect(WALLET_SCORING_QUEUE).toBe('wallet-scoring');
    });
  });

  // -------------------------------------------------------------------------
  // BullMQ retry policy: P3g1 [OPEN-4] — attempts:2, fixed 60 s
  // -------------------------------------------------------------------------

  describe('WALLET_HARVEST_JOB_OPTIONS retry policy (DoD §E)', () => {
    it('has attempts: 2', () => {
      expect(WALLET_HARVEST_JOB_OPTIONS.attempts).toBe(2);
    });

    it('has backoff type "fixed"', () => {
      expect(WALLET_HARVEST_JOB_OPTIONS.backoff.type).toBe('fixed');
    });

    it('has backoff delay of 60_000 ms (60 s)', () => {
      expect(WALLET_HARVEST_JOB_OPTIONS.backoff.delay).toBe(60_000);
    });

    it('retains last 50 completed jobs', () => {
      expect(WALLET_HARVEST_JOB_OPTIONS.removeOnComplete).toBe(50);
    });

    it('retains last 20 failed jobs', () => {
      expect(WALLET_HARVEST_JOB_OPTIONS.removeOnFail).toBe(20);
    });
  });

  // -------------------------------------------------------------------------
  // PR-B: WALLET_SCORING_JOB_OPTIONS retry policy
  // -------------------------------------------------------------------------

  describe('WALLET_SCORING_JOB_OPTIONS retry policy (DoD §E — PR-B)', () => {
    it('has attempts: 2', () => {
      expect(WALLET_SCORING_JOB_OPTIONS.attempts).toBe(2);
    });

    it('has backoff type "fixed"', () => {
      expect(WALLET_SCORING_JOB_OPTIONS.backoff.type).toBe('fixed');
    });

    it('has backoff delay of 60_000 ms (60 s)', () => {
      expect(WALLET_SCORING_JOB_OPTIONS.backoff.delay).toBe(60_000);
    });

    it('retains last 50 completed jobs', () => {
      expect(WALLET_SCORING_JOB_OPTIONS.removeOnComplete).toBe(50);
    });

    it('retains last 20 failed jobs', () => {
      expect(WALLET_SCORING_JOB_OPTIONS.removeOnFail).toBe(20);
    });

    it('policy is identical to harvest policy (unified P3g1 [OPEN-4] decision)', () => {
      // Both scoring and harvest use the same retry policy — enforced statically.
      expect(WALLET_SCORING_JOB_OPTIONS.attempts).toBe(WALLET_HARVEST_JOB_OPTIONS.attempts);
      expect(WALLET_SCORING_JOB_OPTIONS.backoff.type).toBe(WALLET_HARVEST_JOB_OPTIONS.backoff.type);
      expect(WALLET_SCORING_JOB_OPTIONS.backoff.delay).toBe(WALLET_HARVEST_JOB_OPTIONS.backoff.delay);
    });
  });

  // -------------------------------------------------------------------------
  // HarvestProcessor importability (DI resolution without bootstrap)
  // -------------------------------------------------------------------------

  describe('HarvestProcessor', () => {
    it('is a class (importable from expected path)', () => {
      expect(HarvestProcessor).toBeDefined();
      expect(typeof HarvestProcessor).toBe('function');
    });

    it('prototype has a process() method (WorkerHost contract)', () => {
      expect(typeof HarvestProcessor.prototype.process).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  // PR-B: ScoreWalletsProcessor importability (DI resolution without bootstrap)
  // -------------------------------------------------------------------------

  describe('ScoreWalletsProcessor (PR-B)', () => {
    it('is a class (importable from expected path)', () => {
      expect(ScoreWalletsProcessor).toBeDefined();
      expect(typeof ScoreWalletsProcessor).toBe('function');
    });

    it('prototype has a process() method (WorkerHost contract)', () => {
      expect(typeof ScoreWalletsProcessor.prototype.process).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  // PR-C: WALLET_ACTIVITY_QUEUE constant parity
  // -------------------------------------------------------------------------

  describe('WALLET_ACTIVITY_QUEUE constant (PR-C)', () => {
    it('worker re-export equals the domain canonical value', () => {
      expect(WALLET_ACTIVITY_QUEUE).toBe(DOMAIN_ACTIVITY_QUEUE);
    });

    it('equals "wallet-activity"', () => {
      expect(WALLET_ACTIVITY_QUEUE).toBe('wallet-activity');
    });
  });

  // -------------------------------------------------------------------------
  // PR-C: WALLET_ACTIVITY_JOB_OPTIONS retry policy
  // -------------------------------------------------------------------------

  describe('WALLET_ACTIVITY_JOB_OPTIONS retry policy (DoD §E — PR-C)', () => {
    it('has attempts: 2', () => {
      expect(WALLET_ACTIVITY_JOB_OPTIONS.attempts).toBe(2);
    });

    it('has backoff type "fixed"', () => {
      expect(WALLET_ACTIVITY_JOB_OPTIONS.backoff.type).toBe('fixed');
    });

    it('has backoff delay of 60_000 ms (60 s)', () => {
      expect(WALLET_ACTIVITY_JOB_OPTIONS.backoff.delay).toBe(60_000);
    });

    it('retains last 50 completed jobs', () => {
      expect(WALLET_ACTIVITY_JOB_OPTIONS.removeOnComplete).toBe(50);
    });

    it('retains last 20 failed jobs', () => {
      expect(WALLET_ACTIVITY_JOB_OPTIONS.removeOnFail).toBe(20);
    });

    it('policy is identical to harvest and scoring policy (unified P3g1 [OPEN-4] decision)', () => {
      expect(WALLET_ACTIVITY_JOB_OPTIONS.attempts).toBe(WALLET_HARVEST_JOB_OPTIONS.attempts);
      expect(WALLET_ACTIVITY_JOB_OPTIONS.backoff.type).toBe(WALLET_HARVEST_JOB_OPTIONS.backoff.type);
      expect(WALLET_ACTIVITY_JOB_OPTIONS.backoff.delay).toBe(WALLET_HARVEST_JOB_OPTIONS.backoff.delay);
    });
  });

  // -------------------------------------------------------------------------
  // PR-C: ActivityWalletsProcessor importability (DI resolution without bootstrap)
  // -------------------------------------------------------------------------

  describe('ActivityWalletsProcessor (PR-C)', () => {
    it('is a class (importable from expected path)', () => {
      expect(ActivityWalletsProcessor).toBeDefined();
      expect(typeof ActivityWalletsProcessor).toBe('function');
    });

    it('prototype has a process() method (WorkerHost contract)', () => {
      expect(typeof ActivityWalletsProcessor.prototype.process).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  // PR-D: GOVERNANCE_DRIFT_QUEUE constant parity
  // -------------------------------------------------------------------------

  describe('GOVERNANCE_DRIFT_QUEUE constant (PR-D)', () => {
    it('worker re-export equals the domain canonical value', () => {
      expect(GOVERNANCE_DRIFT_QUEUE).toBe(DOMAIN_GOVERNANCE_DRIFT_QUEUE);
    });

    it('equals "governance-drift"', () => {
      expect(GOVERNANCE_DRIFT_QUEUE).toBe('governance-drift');
    });
  });

  // -------------------------------------------------------------------------
  // PR-D: GOVERNANCE_DRIFT_JOB_OPTIONS retry policy
  // -------------------------------------------------------------------------

  describe('GOVERNANCE_DRIFT_JOB_OPTIONS retry policy (DoD §E — PR-D)', () => {
    it('has attempts: 2', () => {
      expect(GOVERNANCE_DRIFT_JOB_OPTIONS.attempts).toBe(2);
    });

    it('has backoff type "fixed"', () => {
      expect(GOVERNANCE_DRIFT_JOB_OPTIONS.backoff.type).toBe('fixed');
    });

    it('has backoff delay of 60_000 ms (60 s)', () => {
      expect(GOVERNANCE_DRIFT_JOB_OPTIONS.backoff.delay).toBe(60_000);
    });

    it('retains last 50 completed jobs', () => {
      expect(GOVERNANCE_DRIFT_JOB_OPTIONS.removeOnComplete).toBe(50);
    });

    it('retains last 20 failed jobs', () => {
      expect(GOVERNANCE_DRIFT_JOB_OPTIONS.removeOnFail).toBe(20);
    });

    it('policy is identical to harvest policy (unified P3g2 decision)', () => {
      expect(GOVERNANCE_DRIFT_JOB_OPTIONS.attempts).toBe(WALLET_HARVEST_JOB_OPTIONS.attempts);
      expect(GOVERNANCE_DRIFT_JOB_OPTIONS.backoff.type).toBe(WALLET_HARVEST_JOB_OPTIONS.backoff.type);
      expect(GOVERNANCE_DRIFT_JOB_OPTIONS.backoff.delay).toBe(WALLET_HARVEST_JOB_OPTIONS.backoff.delay);
    });
  });

  // -------------------------------------------------------------------------
  // PR-D: GovernanceDriftProcessor importability
  // -------------------------------------------------------------------------

  describe('GovernanceDriftProcessor (PR-D)', () => {
    it('is a class (importable from expected path)', () => {
      expect(GovernanceDriftProcessor).toBeDefined();
      expect(typeof GovernanceDriftProcessor).toBe('function');
    });

    it('prototype has a process() method (WorkerHost contract)', () => {
      expect(typeof GovernanceDriftProcessor.prototype.process).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  // PR-D: MULTISIG_TRACKING_QUEUE constant parity
  // -------------------------------------------------------------------------

  describe('MULTISIG_TRACKING_QUEUE constant (PR-D)', () => {
    it('worker re-export equals the domain canonical value', () => {
      expect(MULTISIG_TRACKING_QUEUE).toBe(DOMAIN_MULTISIG_TRACKING_QUEUE);
    });

    it('equals "multisig-tracking"', () => {
      expect(MULTISIG_TRACKING_QUEUE).toBe('multisig-tracking');
    });
  });

  // -------------------------------------------------------------------------
  // PR-D: MULTISIG_TRACKING_JOB_OPTIONS retry policy
  // -------------------------------------------------------------------------

  describe('MULTISIG_TRACKING_JOB_OPTIONS retry policy (DoD §E — PR-D)', () => {
    it('has attempts: 2', () => {
      expect(MULTISIG_TRACKING_JOB_OPTIONS.attempts).toBe(2);
    });

    it('has backoff type "fixed"', () => {
      expect(MULTISIG_TRACKING_JOB_OPTIONS.backoff.type).toBe('fixed');
    });

    it('has backoff delay of 60_000 ms (60 s)', () => {
      expect(MULTISIG_TRACKING_JOB_OPTIONS.backoff.delay).toBe(60_000);
    });

    it('retains last 50 completed jobs', () => {
      expect(MULTISIG_TRACKING_JOB_OPTIONS.removeOnComplete).toBe(50);
    });

    it('retains last 20 failed jobs', () => {
      expect(MULTISIG_TRACKING_JOB_OPTIONS.removeOnFail).toBe(20);
    });

    it('policy is identical to harvest policy (unified P3g2 decision)', () => {
      expect(MULTISIG_TRACKING_JOB_OPTIONS.attempts).toBe(WALLET_HARVEST_JOB_OPTIONS.attempts);
      expect(MULTISIG_TRACKING_JOB_OPTIONS.backoff.type).toBe(WALLET_HARVEST_JOB_OPTIONS.backoff.type);
      expect(MULTISIG_TRACKING_JOB_OPTIONS.backoff.delay).toBe(WALLET_HARVEST_JOB_OPTIONS.backoff.delay);
    });
  });

  // -------------------------------------------------------------------------
  // PR-D: MultisigTrackerProcessor importability
  // -------------------------------------------------------------------------

  describe('MultisigTrackerProcessor (PR-D)', () => {
    it('is a class (importable from expected path)', () => {
      expect(MultisigTrackerProcessor).toBeDefined();
      expect(typeof MultisigTrackerProcessor).toBe('function');
    });

    it('prototype has a process() method (WorkerHost contract)', () => {
      expect(typeof MultisigTrackerProcessor.prototype.process).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  // PR-E: POSITION_RECONCILE_QUEUE constant parity
  // -------------------------------------------------------------------------

  describe('POSITION_RECONCILE_QUEUE constant (PR-E)', () => {
    it('worker re-export equals the domain canonical value', () => {
      expect(POSITION_RECONCILE_QUEUE).toBe(DOMAIN_POSITION_RECONCILE_QUEUE);
    });

    it('equals "position-reconcile"', () => {
      expect(POSITION_RECONCILE_QUEUE).toBe('position-reconcile');
    });
  });

  // -------------------------------------------------------------------------
  // PR-E: POSITION_RECONCILE_JOB_OPTIONS retry policy
  // -------------------------------------------------------------------------

  describe('POSITION_RECONCILE_JOB_OPTIONS retry policy (DoD §E — PR-E)', () => {
    it('has attempts: 2', () => {
      expect(POSITION_RECONCILE_JOB_OPTIONS.attempts).toBe(2);
    });

    it('has backoff type "fixed"', () => {
      expect(POSITION_RECONCILE_JOB_OPTIONS.backoff.type).toBe('fixed');
    });

    it('has backoff delay of 60_000 ms (60 s)', () => {
      expect(POSITION_RECONCILE_JOB_OPTIONS.backoff.delay).toBe(60_000);
    });

    it('retains last 50 completed jobs', () => {
      expect(POSITION_RECONCILE_JOB_OPTIONS.removeOnComplete).toBe(50);
    });

    it('retains last 20 failed jobs', () => {
      expect(POSITION_RECONCILE_JOB_OPTIONS.removeOnFail).toBe(20);
    });

    it('policy is identical to harvest policy (unified P3g2 decision)', () => {
      expect(POSITION_RECONCILE_JOB_OPTIONS.attempts).toBe(WALLET_HARVEST_JOB_OPTIONS.attempts);
      expect(POSITION_RECONCILE_JOB_OPTIONS.backoff.type).toBe(WALLET_HARVEST_JOB_OPTIONS.backoff.type);
      expect(POSITION_RECONCILE_JOB_OPTIONS.backoff.delay).toBe(WALLET_HARVEST_JOB_OPTIONS.backoff.delay);
    });
  });

  // -------------------------------------------------------------------------
  // PR-E: PositionReconcileProcessor importability
  // -------------------------------------------------------------------------

  describe('PositionReconcileProcessor (PR-E)', () => {
    it('is a class (importable from expected path)', () => {
      expect(PositionReconcileProcessor).toBeDefined();
      expect(typeof PositionReconcileProcessor).toBe('function');
    });

    it('prototype has a process() method (WorkerHost contract)', () => {
      expect(typeof PositionReconcileProcessor.prototype.process).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  // PR-E: PORTFOLIO_REPORT_QUEUE constant parity
  // -------------------------------------------------------------------------

  describe('PORTFOLIO_REPORT_QUEUE constant (PR-E)', () => {
    it('worker re-export equals the domain canonical value', () => {
      expect(PORTFOLIO_REPORT_QUEUE).toBe(DOMAIN_PORTFOLIO_REPORT_QUEUE);
    });

    it('equals "portfolio-report"', () => {
      expect(PORTFOLIO_REPORT_QUEUE).toBe('portfolio-report');
    });
  });

  // -------------------------------------------------------------------------
  // PR-E: PORTFOLIO_REPORT_JOB_OPTIONS retry policy
  // -------------------------------------------------------------------------

  describe('PORTFOLIO_REPORT_JOB_OPTIONS retry policy (DoD §E — PR-E)', () => {
    it('has attempts: 2', () => {
      expect(PORTFOLIO_REPORT_JOB_OPTIONS.attempts).toBe(2);
    });

    it('has backoff type "fixed"', () => {
      expect(PORTFOLIO_REPORT_JOB_OPTIONS.backoff.type).toBe('fixed');
    });

    it('has backoff delay of 60_000 ms (60 s)', () => {
      expect(PORTFOLIO_REPORT_JOB_OPTIONS.backoff.delay).toBe(60_000);
    });

    it('retains last 50 completed jobs', () => {
      expect(PORTFOLIO_REPORT_JOB_OPTIONS.removeOnComplete).toBe(50);
    });

    it('retains last 20 failed jobs', () => {
      expect(PORTFOLIO_REPORT_JOB_OPTIONS.removeOnFail).toBe(20);
    });

    it('policy is identical to harvest policy (unified P3g2 decision)', () => {
      expect(PORTFOLIO_REPORT_JOB_OPTIONS.attempts).toBe(WALLET_HARVEST_JOB_OPTIONS.attempts);
      expect(PORTFOLIO_REPORT_JOB_OPTIONS.backoff.type).toBe(WALLET_HARVEST_JOB_OPTIONS.backoff.type);
      expect(PORTFOLIO_REPORT_JOB_OPTIONS.backoff.delay).toBe(WALLET_HARVEST_JOB_OPTIONS.backoff.delay);
    });
  });

  // -------------------------------------------------------------------------
  // PR-E: PortfolioReportProcessor importability
  // -------------------------------------------------------------------------

  describe('PortfolioReportProcessor (PR-E)', () => {
    it('is a class (importable from expected path)', () => {
      expect(PortfolioReportProcessor).toBeDefined();
      expect(typeof PortfolioReportProcessor).toBe('function');
    });

    it('prototype has a process() method (WorkerHost contract)', () => {
      expect(typeof PortfolioReportProcessor.prototype.process).toBe('function');
    });
  });
});
