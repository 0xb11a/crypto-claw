// ============================================================
// price-oracle.js — Independent price source for execute-time
// quote validation (PR 2.7).
//
// Defangs threat #9 (slippage check is self-referential). The
// existing slippage logic compares the aggregator's quote against
// itself — an attacker who compromises 1inch / Jupiter / DEXScreener
// can return a manipulated quote that still passes the slippage cap
// because the "expected" price is set by the same compromised
// source.
//
// PR 2.7 adds an INDEPENDENT cross-check at signing time. Pulls a
// reference price from a source that doesn't share infrastructure
// with the aggregator: ideally Pyth (Solana) / Chainlink (EVM) for
// majors, falling back to a 2-of-2 agreement between DEXScreener
// and Birdeye for long-tail tokens (where no oracle feed exists).
//
// If the aggregator's effective price drifts > 5% from the oracle
// price, abort the trade. Operator can bypass with
// SKIP_PRICE_ORACLE=true during a genuine API outage.
// ============================================================

import 'dotenv/config';
import { log } from './log.js';
import { isEVM, isSolana, getChain } from './chains.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';
const BIRDEYE_BASE = 'https://public-api.birdeye.so/defi/price';
const FETCH_TIMEOUT_MS = 8_000;

// Fallback agreement is OK if the two sources are within this %.
const TWO_SOURCE_AGREEMENT_PCT = 2;

// ============================================================
// Source 1: DEXScreener
// ============================================================

async function fetchDexScreenerPrice(_chain, address) {
  try {
    const res = await fetch(`${DEXSCREENER_BASE}/tokens/${address}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs ?? [];
    if (pairs.length === 0) return null;
    const mainPair = pairs.sort((a, b) => parseFloat(b.liquidity?.usd ?? 0) - parseFloat(a.liquidity?.usd ?? 0))[0];
    const price = parseFloat(mainPair.priceUsd ?? 0);
    return price > 0 ? price : null;
  } catch (err) {
    log('warn', 'price-oracle', `dexscreener fetch failed for ${address}: ${err.message ?? err}`);
    return null;
  }
}

// ============================================================
// Source 2: Birdeye (per-chain)
// ============================================================

async function fetchBirdeyePrice(chain, address) {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) return null;
  let birdeyeChain;
  try {
    birdeyeChain = getChain(chain).birdeye;
  } catch {
    return null;
  }
  if (!birdeyeChain) return null;
  try {
    const url = `${BIRDEYE_BASE}?address=${address}`;
    const res = await fetch(url, {
      headers: { 'X-API-KEY': apiKey, 'x-chain': birdeyeChain },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success || !data.data?.value) return null;
    const price = parseFloat(data.data.value);
    return price > 0 ? price : null;
  } catch (err) {
    log('warn', 'price-oracle', `birdeye fetch failed for ${address} on ${chain}: ${err.message ?? err}`);
    return null;
  }
}

// ============================================================
// Source 3 (TODO): Pyth / Chainlink — only useful for majors with
// existing feeds (USDC/WETH/SOL/etc). Most of our trade universe
// is long-tail moonshots without oracle coverage, so the 2-of-2
// fallback is the realistic primary path. Stub returns null for
// now — fill in when we add a major-token feed map.
// ============================================================

async function fetchPythPrice(_chain, _address) {
  return null;
}

async function fetchChainlinkPrice(_chain, _address) {
  return null;
}

// ============================================================
// Aggregation: try oracle → fall back to 2-of-2 DEX agreement
// ============================================================

/**
 * Returns a reference price for a token, or null if no source
 * could agree on one.
 *
 * Result shape: { price, source } where source is one of
 * 'pyth', 'chainlink', 'dex_2of2', or null when nothing worked.
 *
 * @returns {Promise<{ price: number, source: string } | null>}
 */
export async function fetchOraclePrice(chain, address) {
  // 1. Try the formal oracle first (currently stubbed).
  const oracleFn = isSolana(chain) ? fetchPythPrice : isEVM(chain) ? fetchChainlinkPrice : null;
  if (oracleFn) {
    const oraclePrice = await oracleFn(chain, address);
    if (oraclePrice !== null) {
      return { price: oraclePrice, source: isSolana(chain) ? 'pyth' : 'chainlink' };
    }
  }

  // 2. Fall back: DEXScreener + Birdeye, require 2-of-2 agreement.
  const [dexPrice, birdPrice] = await Promise.all([
    fetchDexScreenerPrice(chain, address),
    fetchBirdeyePrice(chain, address),
  ]);

  if (dexPrice === null || birdPrice === null) return null;

  const agreement = evaluateTwoSourceAgreement({
    priceA: dexPrice,
    priceB: birdPrice,
    maxAgreementPct: TWO_SOURCE_AGREEMENT_PCT,
  });
  if (!agreement.valid) return null;
  return { price: (dexPrice + birdPrice) / 2, source: 'dex_2of2' };
}

// ============================================================
// Pure predicates — exported for offline testing.
// ============================================================

/**
 * Are two independent price sources within `maxAgreementPct` of
 * each other? If yes, we trust the average. If no, we abort the
 * trade — disagreement means at least one source is wrong (could
 * be stale, manipulated, or a wrapped-vs-unwrapped mismatch).
 */
export function evaluateTwoSourceAgreement({ priceA, priceB, maxAgreementPct = TWO_SOURCE_AGREEMENT_PCT }) {
  if (!Number.isFinite(priceA) || priceA <= 0) {
    return { valid: false, driftPct: NaN, reason: `invalid_price_a: ${priceA}` };
  }
  if (!Number.isFinite(priceB) || priceB <= 0) {
    return { valid: false, driftPct: NaN, reason: `invalid_price_b: ${priceB}` };
  }
  const diff = Math.abs(priceA - priceB);
  const driftPct = (diff / Math.min(priceA, priceB)) * 100;
  if (driftPct > maxAgreementPct) {
    return {
      valid: false,
      driftPct,
      reason: `two_source_disagreement: a=${priceA} b=${priceB} drift=${driftPct.toFixed(2)}% > ${maxAgreementPct}%`,
    };
  }
  return { valid: true, driftPct };
}

/**
 * Compare aggregator quote price to oracle reference price. If they
 * drift > maxDriftPct, abort the trade.
 *
 * @param {object} input
 * @param {number} input.quotePrice    aggregator's effective price (USD per unit)
 * @param {number} input.oraclePrice   independent reference price
 * @param {number} [input.maxDriftPct=5]
 * @returns {{ valid: boolean, driftPct: number, reason?: string }}
 */
export function evaluatePriceDrift({ quotePrice, oraclePrice, maxDriftPct = 5 }) {
  if (!Number.isFinite(quotePrice) || quotePrice <= 0) {
    return { valid: false, driftPct: NaN, reason: `invalid_quote_price: ${quotePrice}` };
  }
  if (!Number.isFinite(oraclePrice) || oraclePrice <= 0) {
    return { valid: false, driftPct: NaN, reason: `invalid_oracle_price: ${oraclePrice}` };
  }
  const diff = Math.abs(quotePrice - oraclePrice);
  const driftPct = (diff / oraclePrice) * 100;
  if (driftPct > maxDriftPct) {
    return {
      valid: false,
      driftPct,
      reason: `quote_oracle_drift: quote=${quotePrice} oracle=${oraclePrice} drift=${driftPct.toFixed(2)}% > ${maxDriftPct}%`,
    };
  }
  return { valid: true, driftPct };
}
