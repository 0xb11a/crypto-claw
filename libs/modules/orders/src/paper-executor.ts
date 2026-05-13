/**
 * paper-executor.ts — Simulates trade execution in paper mode.
 *
 * In paper mode, orders skip the real executor subprocess. This module
 * produces a simulated receipt for P1c-i (entry price = receipt price).
 *
 * A richer simulation (slippage, price drift) is P2 scope.
 *
 * Per plan step 19: simulate(order) returns a paper receipt with
 * currentPrice ≈ entry_price (matches legacy paper-mode behavior for P1c-i).
 *
 * @see SPEC §4 (paper mode short-circuits before executor)
 * @see docs/decisions/0023-signer-env-file-mount.md (paper mode bypasses signer)
 */
import { Injectable } from '@nestjs/common';
import type { OrderResponseDto } from './dto/order-response.dto.js';
import type { CreateReceiptDto } from '@cclaw/receipts';

/**
 * Paper-mode trade simulator.
 *
 * Produces a deterministic paper receipt for a given order.
 * No real signing, no real transaction, no network calls.
 */
@Injectable()
export class PaperExecutor {
  /**
   * Simulate executing an order in paper mode.
   *
   * @param order - The order to simulate.
   * @returns CreateReceiptDto suitable for ReceiptsService.create({mode:'paper'})
   */
  simulate(order: OrderResponseDto): CreateReceiptDto {
    // P1c-i: entry_price is the simulated executed price (no slippage simulation yet).
    // P2 will add market-price lookup and realistic slippage.
    const simulatedPrice = order.entry_price ?? 0;
    const amount = parseFloat(order.amount);
    const quantity = simulatedPrice > 0 ? amount / simulatedPrice : 0;

    return {
      order_id: order.id,
      action: order.action,
      symbol: order.symbol,
      address: order.address,
      chain: order.chain,
      status: 'executed',
      amount,
      quantity,
      expected_price: simulatedPrice,
      executed_price: simulatedPrice,
      slippage: 0, // No slippage in P1c-i stub
      notes: 'paper_mode:simulated',
      mode: 'paper',
    };
  }
}
