export { WalletsModule } from './wallets.module.js';
export { WalletsController } from './wallets.controller.js';
export { SignalsController } from './signals.controller.js';
export { WalletsService } from './wallets.service.js';
export { SignalsService } from './signals.service.js';
export { WalletsRepository } from './wallets.repository.js';
export { SignalsRepository } from './signals.repository.js';
export * from './dto/tracked-wallet-response.dto.js';
export * from './dto/add-tracked-wallet.dto.js';
export * from './dto/propose-wallet.dto.js';
export * from './dto/update-wallet-score.dto.js';
export * from './dto/tracked-wallets-query.dto.js';
export * from './dto/smart-money-signal-response.dto.js';
export * from './dto/signals-query.dto.js';

// Queue name constants (P3g1) — re-exported so consumers don't reach into
// the jobs/ subdirectory directly. Import from '@cclaw/wallets' only.
export {
  WALLET_HARVEST_QUEUE,
  WALLET_SCORING_QUEUE,
  WALLET_ACTIVITY_QUEUE,
  WALLET_HARVEST_JOB_OPTIONS,
  WALLET_SCORING_JOB_OPTIONS,
  WALLET_ACTIVITY_JOB_OPTIONS,
} from './jobs/queue-names.js';
