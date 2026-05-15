/**
 * OnchainBalanceModule — NestJS module providing OnchainBalanceAdapter.
 *
 * Import this module in any NestJS module that needs on-chain token balance
 * reads (EVM via viem, Solana via @solana/web3.js).
 * ConfigModule is global; no explicit import needed here.
 */
import { Module } from '@nestjs/common';
import { OnchainBalanceAdapter } from './onchain-balance.adapter.js';

@Module({
  providers: [OnchainBalanceAdapter],
  exports: [OnchainBalanceAdapter],
})
export class OnchainBalanceModule {}
