/**
 * @cclaw/adapters-zerion — barrel export.
 *
 * Public surface for consumers (apps/worker, libs/modules/wallets jobs).
 */
export { ZerionModule } from './zerion.module.js';
export {
  ZerionAdapter,
  ZerionApiKeyMissingError,
  ZerionRateLimitError,
  ZerionApiError,
  type ZerionPnlResult,
} from './zerion.adapter.js';
