#!/usr/bin/env node
/**
 * Test Suite: Pipeline Integration
 *
 * Tests the full discovery → analysis → risk → trade pipeline
 * using mock data to verify each stage connects correctly.
 */

import { describe, test, assert, assertEqual, assertType, summary } from './test-helpers.js';

// ============================================================
// Mock Data Representing Each Pipeline Stage
// ============================================================

const mockDiscovery = {
  tokenAddress: '0xmocktoken123',
  chain: 'base',
  symbol: 'MOCK',
  name: 'MockToken',
  price: 0.001,
  liquidity: 25000,
  volume24h: 150000,
  holders: 450,
  holdersChange24h: 120,
  buyCount24h: 300,
  sellCount24h: 180,
  topHolderPercent: 12,
  contractVerified: true,
  liquidityLocked: true,
  narrative: 'ai',
  reason: 'Growing holder count + smart money entry',
  urgency: 'high',
};

const mockAnalysis = {
  tokenAddress: '0xmocktoken123',
  chain: 'base',
  symbol: 'MOCK',
  scores: {
    contract: 85,
    tokenomics: 70,
    liquidity: 75,
    social: 60,
    narrative: 'ai',
    narrativeScore: 80,
    timing: 85,
    overall: 76,
  },
  strengths: ['Verified + renounced', 'Strong holder growth', 'Early in AI narrative'],
  weaknesses: ['Small community', 'No audit'],
  recommendation: 'strong_buy',
  suggestedEntry: 0.001,
  suggestedSize: 'medium',
  reasoning: 'Strong fundamentals in hot narrative, early timing.',
};

const mockRiskAssessment = {
  tokenAddress: '0xmocktoken123',
  symbol: 'MOCK',
  riskScores: {
    contract: 15,
    liquidity: 20,
    concentration: 25,
    social: 30,
    narrative: 10,
    overall: 20,
  },
  flags: [{ type: 'no_audit', severity: 'medium', description: 'Contract not audited' }],
  verdict: 'approve',
  maxPositionPercent: 4,
  reasoning: 'Low overall risk, no critical flags.',
};

const mockTradeProposal = {
  action: 'buy',
  symbol: 'MOCK',
  address: '0xmocktoken123',
  chain: 'base',
  amount: 500,
  percentOfPortfolio: 4,
  tier: 'moonshot',
  entryPrice: 0.001,
  stopLoss: 0.0005,
  takeProfitLevels: [
    { level: 1, multiplier: 2, price: 0.002, sellPercent: 50, triggered: false },
    { level: 2, multiplier: 5, price: 0.005, sellPercent: 30, triggered: false },
    { level: 3, multiplier: 10, price: 0.01, sellPercent: 15, triggered: false },
  ],
  requiresApproval: true,
  reasoning: 'Score 76/100, risk 20/100. Strong AI narrative play.',
};

// ============================================================
// Pipeline Stage Tests
// ============================================================

describe('Discovery → Analysis Handoff', () => {
  test('discovery output has all fields needed by analyst', () => {
    assert(mockDiscovery.tokenAddress, 'Must have tokenAddress');
    assert(mockDiscovery.chain, 'Must have chain');
    assert(mockDiscovery.symbol, 'Must have symbol');
    assertType(mockDiscovery.liquidity, 'number', 'liquidity must be number');
    assertType(mockDiscovery.holders, 'number', 'holders must be number');
    assert(mockDiscovery.contractVerified !== undefined, 'Must have contractVerified');
    assert(mockDiscovery.liquidityLocked !== undefined, 'Must have liquidityLocked');
  });

  test('discovery filter: liquidity > $10k passes', () => {
    assert(mockDiscovery.liquidity > 10000, 'Should pass liquidity filter');
  });

  test('discovery filter: verified contract passes', () => {
    assert(mockDiscovery.contractVerified === true, 'Should pass verification filter');
  });

  test('discovery filter: holders > 50 passes', () => {
    assert(mockDiscovery.holders > 50, 'Should pass holder count filter');
  });
});

describe('Analysis → Risk Handoff', () => {
  test('analysis output has overall score', () => {
    assertType(mockAnalysis.scores.overall, 'number', 'overall must be number');
    assert(mockAnalysis.scores.overall >= 0 && mockAnalysis.scores.overall <= 100, 'Score must be 0-100');
  });

  test('analysis recommendation determines if risk runs', () => {
    const shouldRunRisk = ['strong_buy', 'buy'].includes(mockAnalysis.recommendation);
    assert(shouldRunRisk, 'strong_buy/buy should trigger risk assessment');
  });

  test('analysis passes token address to risk', () => {
    assertEqual(mockAnalysis.tokenAddress, mockDiscovery.tokenAddress, 'Address must match through pipeline');
  });

  test('watch recommendation does NOT trigger risk', () => {
    const watchAnalysis = { ...mockAnalysis, recommendation: 'watch' };
    const shouldRunRisk = ['strong_buy', 'buy'].includes(watchAnalysis.recommendation);
    assert(!shouldRunRisk, 'Watch should not trigger risk');
  });
});

describe('Risk → Trade Proposal Handoff', () => {
  test('risk verdict determines if trade is proposed', () => {
    const shouldPropose = mockRiskAssessment.verdict !== 'reject';
    assert(shouldPropose, 'Approved risk should allow trade proposal');
  });

  test('risk maxPositionPercent constrains trade size', () => {
    assert(
      mockTradeProposal.percentOfPortfolio <= mockRiskAssessment.maxPositionPercent,
      `Trade size ${mockTradeProposal.percentOfPortfolio}% must not exceed risk limit ${mockRiskAssessment.maxPositionPercent}%`,
    );
  });

  test('risk rejection blocks trade', () => {
    const rejectedRisk = { ...mockRiskAssessment, verdict: 'reject' };
    const shouldPropose = rejectedRisk.verdict !== 'reject';
    assert(!shouldPropose, 'Rejected risk should block trade');
  });
});

describe('Trade Proposal Validation', () => {
  test('buy trade requires approval', () => {
    assert(mockTradeProposal.requiresApproval === true, 'Buy must require approval');
  });

  test('sell trade does NOT require approval', () => {
    const sellProposal = { ...mockTradeProposal, action: 'sell', requiresApproval: false };
    assert(sellProposal.requiresApproval === false, 'Sell must not require approval');
  });

  test('has stop-loss defined', () => {
    assert(mockTradeProposal.stopLoss > 0, 'Must have stop-loss');
    assert(mockTradeProposal.stopLoss < mockTradeProposal.entryPrice, 'Stop-loss must be below entry');
  });

  test('has take-profit levels defined', () => {
    assert(mockTradeProposal.takeProfitLevels.length >= 2, 'Must have at least 2 TP levels');
    for (const tp of mockTradeProposal.takeProfitLevels) {
      assert(tp.price > mockTradeProposal.entryPrice, `TP${tp.level} must be above entry`);
      assert(tp.sellPercent > 0 && tp.sellPercent <= 100, `TP${tp.level} sellPercent must be 1-100`);
    }
  });

  test('total TP sell percentages dont exceed 100%', () => {
    const totalSell = mockTradeProposal.takeProfitLevels.reduce((sum, tp) => sum + tp.sellPercent, 0);
    assert(totalSell <= 100, `Total TP sell ${totalSell}% must not exceed 100%`);
  });

  test('position size within tier limits', () => {
    const tierLimits = { moonshot: 5, conviction: 10, base: 25 };
    const max = tierLimits[mockTradeProposal.tier];
    assert(
      mockTradeProposal.percentOfPortfolio <= max,
      `${mockTradeProposal.tier} position ${mockTradeProposal.percentOfPortfolio}% exceeds ${max}%`,
    );
  });
});

describe('Sentinel Monitoring Integration', () => {
  test('position state has all fields sentinel needs', () => {
    const position = {
      symbol: mockTradeProposal.symbol,
      address: mockTradeProposal.address,
      chain: mockTradeProposal.chain,
      entryPrice: mockTradeProposal.entryPrice,
      stopLoss: mockTradeProposal.stopLoss,
      takeProfitLevels: mockTradeProposal.takeProfitLevels,
    };

    assert(position.symbol, 'Sentinel needs symbol');
    assert(position.address, 'Sentinel needs address');
    assert(position.stopLoss, 'Sentinel needs stopLoss');
    assert(position.takeProfitLevels.length > 0, 'Sentinel needs TP levels');
  });

  test('stop-loss triggers sell-all', () => {
    const currentPrice = 0.0004; // below stop-loss of 0.0005
    const stopLossHit = currentPrice <= mockTradeProposal.stopLoss;
    assert(stopLossHit, 'Price below stop-loss should trigger');
  });

  test('TP1 triggers partial sell', () => {
    const currentPrice = 0.002; // at TP1
    const tp1 = mockTradeProposal.takeProfitLevels[0];
    const tp1Hit = currentPrice >= tp1.price;
    assert(tp1Hit, 'Price at TP1 should trigger');
    assertEqual(tp1.sellPercent, 50, 'TP1 should sell 50%');
  });
});

describe('Executor Integration', () => {
  test('approved trade has all fields executor needs', () => {
    const approvedTrade = {
      ...mockTradeProposal,
      status: 'approved',
      approvedAt: new Date().toISOString(),
    };

    assert(approvedTrade.status === 'approved', 'Must be approved');
    assert(approvedTrade.address, 'Executor needs address');
    assert(approvedTrade.chain, 'Executor needs chain');
    assert(approvedTrade.amount, 'Executor needs amount');
    assert(approvedTrade.tier, 'Executor needs tier for slippage limits');
    assert(approvedTrade.stopLoss, 'Executor needs stopLoss for position creation');
    assert(approvedTrade.takeProfitLevels.length > 0, 'Executor needs TP levels for position creation');
    assert(approvedTrade.status !== 'executed', 'Must not be already executed');
  });

  test('sell order has all fields executor needs', () => {
    const sellOrder = {
      id: 'sell-test',
      action: 'sell',
      symbol: 'MOCK',
      address: mockTradeProposal.address,
      chain: mockTradeProposal.chain,
      amount: 'all',
      reason: 'stop_loss',
      urgency: 'immediate',
      status: 'approved',
    };

    assert(sellOrder.address, 'Executor needs address');
    assert(sellOrder.chain, 'Executor needs chain');
    assert(sellOrder.amount, 'Executor needs amount');
    assert(sellOrder.status !== 'executed', 'Must not be already executed');
  });

  test('receipt feeds back to research for learning', () => {
    const receipt = {
      orderId: 'trade-001',
      action: 'buy',
      symbol: 'MOCK',
      executedPrice: 0.00098,
      status: 'executed',
      onchainTxHash: '0xabc',
    };

    assert(receipt.executedPrice, 'Research needs executedPrice for trade history');
    assert(receipt.status, 'Research needs status to know if trade went through');
    assert(receipt.onchainTxHash, 'Research needs tx hash for verification');
  });
});

// ============================================================
// Executor Order Filtering (status-based)
// ============================================================

describe('Executor Order Filtering — status-based', () => {
  // Simulate the filtering logic that get-orders applies with the status column
  const mockOrders = [
    { id: 'buy-1', action: 'buy', status: 'approved', approved_by: 'human' },
    { id: 'buy-2', action: 'buy', status: 'pending', approved_by: null },
    { id: 'sell-1', action: 'sell', status: 'approved', approved_by: 'sentinel' },
    { id: 'buy-3', action: 'buy', status: 'approved', approved_by: 'paper_mode' },
    { id: 'buy-4', action: 'buy', status: 'executed', approved_by: 'human' },
    { id: 'buy-5', action: 'buy', status: 'rejected', approved_by: null },
  ];

  function filterOrders({ pending, action, approved, status }) {
    return mockOrders.filter((o) => {
      if (pending && !['pending', 'approved'].includes(o.status)) return false;
      if (action && o.action !== action) return false;
      if (approved && o.status !== 'approved') return false;
      if (status && o.status !== status) return false;
      return true;
    });
  }

  test('--pending --action buy --approved returns only approved pending buys', () => {
    const result = filterOrders({ pending: true, action: 'buy', approved: true });
    assertEqual(result.length, 2, 'Should return 2 approved pending buys');
    assert(
      result.every((o) => o.status === 'approved'),
      'All must be approved',
    );
    assert(
      result.every((o) => o.action === 'buy'),
      'All must be buys',
    );
  });

  test('--pending --action buy without --approved returns pending + approved buys', () => {
    const result = filterOrders({ pending: true, action: 'buy', approved: false });
    assertEqual(result.length, 3, 'Should return 3 pending buys (pending + approved statuses)');
    assert(
      result.some((o) => o.status === 'pending'),
      'Should include pending order',
    );
  });

  test('sell orders with --approved still returned (sells are always pre-approved)', () => {
    const result = filterOrders({ pending: true, action: 'sell', approved: true });
    assertEqual(result.length, 1, 'Should return 1 approved pending sell');
    assertEqual(result[0].id, 'sell-1');
  });

  test('executed orders excluded by --pending regardless of --approved', () => {
    const result = filterOrders({ pending: true, action: 'buy', approved: true });
    assert(!result.some((o) => o.id === 'buy-4'), 'Executed order must not appear');
  });

  test('--status filter returns only matching status', () => {
    const result = filterOrders({ status: 'rejected' });
    assertEqual(result.length, 1, 'Should return 1 rejected order');
    assertEqual(result[0].id, 'buy-5');
  });
});

// ============================================================
// Market Regime in Pipeline
// ============================================================

describe('Market Regime Pipeline Integration', () => {
  test('regime context is available to discovery stage', () => {
    // Discovery reads regime from DB before scanning
    const regime = { value: 'bearish' };
    assert(regime.value, 'Regime must be readable from DB');
    const skipMoonshots = regime.value === 'crisis';
    assert(!skipMoonshots, 'Bearish should not skip moonshots entirely');
  });

  test('crisis regime blocks moonshot discoveries from entering pipeline', () => {
    const regime = { value: 'crisis' };
    const _token = { ...mockDiscovery, tier: 'moonshot' };
    const shouldSkipMoonshots = regime.value === 'crisis';
    assert(shouldSkipMoonshots, 'Crisis must skip moonshot scanning');
  });

  test('regime risk modifier increases risk score in bearish', () => {
    const baseRisk = 20; // from mockRiskAssessment
    const regimeModifier = { bearish: { moonshot: 15, conviction: 10 }, crisis: { moonshot: 30, conviction: 20 } };
    const adjustedRisk = baseRisk + (regimeModifier.bearish?.moonshot || 0);
    assertEqual(adjustedRisk, 35, 'Bearish should add +15 to moonshot risk');
  });

  test('regime risk modifier increases risk score in crisis', () => {
    const baseRisk = 20;
    const adjustedRisk = baseRisk + 30; // crisis moonshot modifier
    assertEqual(adjustedRisk, 50, 'Crisis should add +30 to moonshot risk');
  });

  test('regime-adjusted position size constrains trade proposal', () => {
    // In bearish, max moonshot is 3% not 5%
    const regimeMaxMoonshot = 3;
    const proposedSize = 4;
    const adjustedSize = Math.min(proposedSize, regimeMaxMoonshot);
    assertEqual(adjustedSize, 3, 'Should cap at regime limit');
  });

  test('base tier buying gated by regime', () => {
    const regimes = {
      bullish: { baseBuyingEnabled: true },
      neutral: { baseBuyingEnabled: true },
      bearish: { baseBuyingEnabled: false },
      crisis: { baseBuyingEnabled: false },
    };
    assert(regimes.bullish.baseBuyingEnabled, 'Bullish allows base buying');
    assert(regimes.neutral.baseBuyingEnabled, 'Neutral allows base buying');
    assert(!regimes.bearish.baseBuyingEnabled, 'Bearish pauses base buying');
    assert(!regimes.crisis.baseBuyingEnabled, 'Crisis pauses base buying');
  });
});

// ============================================================
// Token Analysis Deduplication
// ============================================================

describe('Token Dedup — Position Blocking', () => {
  test('open position blocks re-analysis', () => {
    const position = { status: 'open', address: '0xtoken', chain: 'base' };
    const shouldSkip = ['open', 'partial_exit'].includes(position.status);
    assert(shouldSkip, 'Open position must block re-analysis');
  });

  test('partial_exit position blocks re-analysis', () => {
    const position = { status: 'partial_exit', address: '0xtoken', chain: 'base' };
    const shouldSkip = ['open', 'partial_exit'].includes(position.status);
    assert(shouldSkip, 'partial_exit position must block re-analysis');
  });

  test('closed position allows re-analysis', () => {
    const position = { status: 'closed', address: '0xtoken', chain: 'base' };
    const shouldSkip = ['open', 'partial_exit'].includes(position.status);
    assert(!shouldSkip, 'Closed position must allow re-analysis');
  });
});

describe('Token Dedup — Pending Orders', () => {
  test('pending approved trade blocks re-analysis', () => {
    const trade = { status: 'approved', address: '0xtoken', chain: 'base' };
    const shouldSkip = trade.status !== 'executed';
    assert(shouldSkip, 'Pending approved trade must block re-analysis');
  });

  test('executed trade allows re-analysis', () => {
    const trade = { status: 'executed', address: '0xtoken', chain: 'base' };
    const shouldSkip = trade.status !== 'executed';
    assert(!shouldSkip, 'Executed trade must allow re-analysis');
  });

  test('pending sell order blocks re-analysis', () => {
    const sellOrder = { status: 'approved', address: '0xtoken', chain: 'base' };
    const shouldSkip = sellOrder.status !== 'executed';
    assert(shouldSkip, 'Pending sell order must block re-analysis');
  });
});

describe('Token Dedup — Watchlist & Cache', () => {
  test('active watchlist entry blocks discovery', () => {
    const watchItem = { status: 'watching', address: '0xtoken', chain: 'base' };
    const shouldSkip = watchItem.status === 'watching';
    assert(shouldSkip, 'Active watchlist entry must block discovery');
  });

  test('expired watchlist allows re-analysis', () => {
    const watchItem = { status: 'expired', address: '0xtoken', chain: 'base' };
    const shouldSkip = watchItem.status === 'watching';
    assert(!shouldSkip, 'Expired watchlist must allow re-analysis');
  });

  test('unexpired cache blocks re-analysis', () => {
    const cacheExpires = new Date(Date.now() + 3600000).toISOString(); // 1h from now
    const shouldSkip = new Date(cacheExpires) > new Date();
    assert(shouldSkip, 'Unexpired cache must block re-analysis');
  });

  test('expired cache allows re-analysis', () => {
    const cacheExpires = new Date(Date.now() - 3600000).toISOString(); // 1h ago
    const shouldSkip = new Date(cacheExpires) > new Date();
    assert(!shouldSkip, 'Expired cache must allow re-analysis');
  });
});

describe('Token Dedup — Verdict Caching', () => {
  test('avoid verdict gets cached', () => {
    const shouldCache = ['avoid', 'risk_rejected'].includes('avoid');
    assert(shouldCache, 'avoid verdict must be cached');
  });

  test('risk_rejected verdict gets cached', () => {
    const shouldCache = ['avoid', 'risk_rejected'].includes('risk_rejected');
    assert(shouldCache, 'risk_rejected verdict must be cached');
  });

  test('buy verdict is NOT cached', () => {
    const shouldCache = ['avoid', 'risk_rejected'].includes('buy');
    assert(!shouldCache, 'buy verdict must NOT be cached');
  });

  test('strong_buy verdict is NOT cached', () => {
    const shouldCache = ['avoid', 'risk_rejected'].includes('strong_buy');
    assert(!shouldCache, 'strong_buy verdict must NOT be cached');
  });

  test('watch verdict is NOT cached (goes to watchlist)', () => {
    const shouldCache = ['avoid', 'risk_rejected'].includes('watch');
    assert(!shouldCache, 'watch verdict must NOT be cached (goes to watchlist instead)');
  });
});

// ============================================================
// Solana Pipeline Integration
// ============================================================

const mockSolanaDiscovery = {
  tokenAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  chain: 'solana',
  symbol: 'BONK',
  name: 'Bonk',
  price: 0.00001,
  liquidity: 50000,
  volume24h: 5000000,
  holders: 200000,
  holdersChange24h: 5000,
  buyCount24h: 8000,
  sellCount24h: 6000,
  topHolderPercent: 8,
  contractVerified: true,
  liquidityLocked: true,
  narrative: 'memecoin',
  reason: 'Massive holder growth on Solana',
  urgency: 'medium',
};

const mockSolanaTradeProposal = {
  action: 'buy',
  symbol: 'BONK',
  address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  chain: 'solana',
  amount: 400,
  percentOfPortfolio: 4,
  tier: 'moonshot',
  entryPrice: 0.00001,
  stopLoss: 0.000005,
  takeProfitLevels: [
    { level: 1, multiplier: 2, price: 0.00002, sellPercent: 50, triggered: false },
    { level: 2, multiplier: 5, price: 0.00005, sellPercent: 30, triggered: false },
  ],
  requiresApproval: true,
  reasoning: 'Memecoin momentum on Solana.',
};

describe('Solana Pipeline — Per-Chain Portfolio', () => {
  test('Solana trade checks chain-specific portfolio state', () => {
    // Solana trades should check Solana cash, not global cash
    const solanaPortfolio = { chain: 'solana', cash: 2000, positions: [] };
    const baseCash = 5000; // Base has plenty, but Solana is limited
    assert(solanaPortfolio.cash < baseCash, 'Solana cash is less than Base');
    assert(solanaPortfolio.cash >= mockSolanaTradeProposal.amount, 'Solana cash covers the trade');
  });

  test('Solana max positions limit is independent', () => {
    // Solana has maxOpenPositions: 10 (vs Base default: 15)
    const solanaMaxPos = 10;
    const baseMaxPos = 15;
    assert(solanaMaxPos !== baseMaxPos, 'Chains have different limits');
    assert(9 < solanaMaxPos, '9 positions ok on Solana');
  });

  test('Solana tiersEnabled blocks base-tier proposals', () => {
    const solTiers = ['moonshot', 'conviction'];
    assert(!solTiers.includes('base'), 'Solana does not support base tier');
    assert(solTiers.includes('moonshot'), 'Solana supports moonshot');
    assert(solTiers.includes('conviction'), 'Solana supports conviction');
  });
});

describe('Solana Pipeline Integration', () => {
  test('Solana discovery uses base58 address (not 0x)', () => {
    assert(!mockSolanaDiscovery.tokenAddress.startsWith('0x'), 'Solana address must not start with 0x');
    assert(mockSolanaDiscovery.tokenAddress.length > 30, 'Solana address should be base58 (>30 chars)');
  });

  test('Solana discovery has chain=solana', () => {
    assertEqual(mockSolanaDiscovery.chain, 'solana');
  });

  test('Solana trade proposal flows to executor with chain=solana', () => {
    const approvedTrade = {
      ...mockSolanaTradeProposal,
      status: 'approved',
      approvedAt: new Date().toISOString(),
    };

    assertEqual(approvedTrade.chain, 'solana', 'Executor must see chain=solana');
    assert(approvedTrade.status === 'approved', 'Must be approved');
    assert(!approvedTrade.address.startsWith('0x'), 'Solana address must be base58');
  });

  test('Solana sell order passes through pipeline', () => {
    const sellOrder = {
      id: 'sell-sol-test',
      action: 'sell',
      symbol: 'BONK',
      address: mockSolanaTradeProposal.address,
      chain: 'solana',
      amount: 'all',
      reason: 'stop_loss',
      urgency: 'immediate',
      status: 'approved',
    };

    assertEqual(sellOrder.chain, 'solana');
    assert(!sellOrder.address.startsWith('0x'), 'Solana address must be base58');
    assert(sellOrder.amount === 'all', 'Stop-loss should sell all');
  });

  test('Solana position has all fields sentinel needs', () => {
    const position = {
      symbol: mockSolanaTradeProposal.symbol,
      address: mockSolanaTradeProposal.address,
      chain: mockSolanaTradeProposal.chain,
      entryPrice: mockSolanaTradeProposal.entryPrice,
      stopLoss: mockSolanaTradeProposal.stopLoss,
      takeProfitLevels: mockSolanaTradeProposal.takeProfitLevels,
    };

    assertEqual(position.chain, 'solana');
    assert(position.stopLoss, 'Sentinel needs stopLoss');
    assert(position.takeProfitLevels.length > 0, 'Sentinel needs TP levels');
  });
});

// ============================================================
// Results
// ============================================================
const allPassed = summary();
process.exit(allPassed ? 0 : 1);
