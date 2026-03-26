/**
 * narrative-config.js — Shared narrative taxonomy (single source of truth)
 *
 * All narrative definitions live here. Both narrative-check.js and
 * narrative-deep-scan.js import from this module.
 *
 * Usage:
 *   import { NARRATIVES, getNarrative, getNarrativesByCategory, getAllIds } from './narrative-config.js';
 */

/**
 * Tier affinity levels:
 *   strong_conviction — Always conviction if token meets criteria. Narrative score boost +15 when hot/warming.
 *   lean_conviction   — Conviction if token meets criteria. Narrative score boost +10.
 *   lean_moonshot     — Default moonshot. Only conviction if exceptional (age >30d, liq >$500k).
 *   strong_moonshot   — Always moonshot regardless of metrics. Volatility profile too high for conviction.
 */

export const NARRATIVES = {
  // ── Infrastructure & Scaling ──────────────────────────────────────
  l2: {
    name: 'Layer 2 / Rollups',
    category: 'infrastructure',
    tierAffinity: 'strong_conviction',
    keywords: ['L2', 'rollup', 'scaling', 'optimistic', 'ZK rollup'],
  },
  zk: {
    name: 'ZK Technology',
    category: 'infrastructure',
    tierAffinity: 'strong_conviction',
    keywords: ['ZK', 'zero knowledge', 'zkEVM', 'ZK proof', 'SNARK'],
  },
  modular: {
    name: 'Modular Blockchain',
    category: 'infrastructure',
    tierAffinity: 'strong_conviction',
    keywords: ['modular', 'data availability', 'DA layer', 'Celestia', 'EigenDA'],
  },
  intents: {
    name: 'Chain Abstraction',
    category: 'infrastructure',
    tierAffinity: 'lean_moonshot',
    keywords: ['intent', 'chain abstraction', 'cross-chain', 'interop', 'bridge'],
  },
  depin: {
    name: 'DePIN',
    category: 'infrastructure',
    tierAffinity: 'lean_conviction',
    keywords: ['DePIN', 'IoT', 'decentralized infrastructure', 'compute', 'wireless'],
  },

  // ── AI & Data ─────────────────────────────────────────────────────
  ai_infra: {
    name: 'AI Infrastructure',
    category: 'ai_data',
    tierAffinity: 'lean_conviction',
    keywords: ['AI', 'GPU', 'compute', 'inference', 'AI infrastructure'],
  },
  ai_agents: {
    name: 'AI Agents',
    category: 'ai_data',
    tierAffinity: 'lean_moonshot',
    keywords: ['AI agent', 'autonomous', 'agentic', 'agent framework'],
  },
  desci: {
    name: 'DeSci',
    category: 'ai_data',
    tierAffinity: 'strong_moonshot',
    keywords: ['DeSci', 'decentralized science', 'research DAO', 'biotech'],
  },

  // ── DeFi & Yield ──────────────────────────────────────────────────
  defi: {
    name: 'DeFi Core',
    category: 'defi_yield',
    tierAffinity: 'strong_conviction',
    keywords: ['DeFi', 'DEX', 'lending', 'swap', 'AMM'],
  },
  restaking: {
    name: 'Restaking / LRT',
    category: 'defi_yield',
    tierAffinity: 'strong_conviction',
    keywords: ['restaking', 'liquid restaking', 'LRT', 'EigenLayer', 'AVS'],
  },
  lst: {
    name: 'Liquid Staking',
    category: 'defi_yield',
    tierAffinity: 'strong_conviction',
    keywords: ['liquid staking', 'LST', 'staked ETH', 'stETH', 'staking'],
  },
  yield: {
    name: 'Yield Aggregation',
    category: 'defi_yield',
    tierAffinity: 'lean_conviction',
    keywords: ['yield', 'vault', 'auto-compound', 'yield optimizer', 'real yield'],
  },
  payfi: {
    name: 'PayFi / Payments',
    category: 'defi_yield',
    tierAffinity: 'lean_conviction',
    keywords: ['PayFi', 'payment', 'stablecoin', 'remittance', 'BNPL'],
  },

  // ── Real World ────────────────────────────────────────────────────
  rwa: {
    name: 'RWA / Tokenization',
    category: 'real_world',
    tierAffinity: 'strong_conviction',
    keywords: ['RWA', 'real world asset', 'tokenized', 'treasury', 'T-bill'],
  },
  prediction: {
    name: 'Prediction Markets',
    category: 'real_world',
    tierAffinity: 'lean_conviction',
    keywords: ['prediction', 'betting', 'oracle', 'Polymarket', 'forecast'],
  },

  // ── Social & Culture ──────────────────────────────────────────────
  memecoin: {
    name: 'Memecoins',
    category: 'social_culture',
    tierAffinity: 'strong_moonshot',
    keywords: ['meme', 'PEPE', 'DOGE', 'WIF', 'BONK', 'pump.fun'],
  },
  socialfi: {
    name: 'SocialFi',
    category: 'social_culture',
    tierAffinity: 'strong_moonshot',
    keywords: ['SocialFi', 'social', 'creator', 'content', 'Lens'],
  },
  gaming: {
    name: 'Gaming / Metaverse',
    category: 'social_culture',
    tierAffinity: 'lean_moonshot',
    keywords: ['game', 'play to earn', 'metaverse', 'GameFi', 'NFT game'],
  },
  nft_infra: {
    name: 'NFT Infrastructure',
    category: 'social_culture',
    tierAffinity: 'lean_moonshot',
    keywords: ['NFT', 'marketplace', 'NFT-Fi', 'lending NFT'],
  },

  // ── BTC Ecosystem ─────────────────────────────────────────────────
  btc_eco: {
    name: 'BTC Ecosystem',
    category: 'btc_ecosystem',
    tierAffinity: 'lean_moonshot',
    keywords: ['Bitcoin DeFi', 'BRC-20', 'ordinals', 'runes', 'BTC L2'],
  },
  btc_l2: {
    name: 'Bitcoin L2',
    category: 'btc_ecosystem',
    tierAffinity: 'lean_moonshot',
    keywords: ['Bitcoin L2', 'Stacks', 'BOB', 'Merlin', 'BTC sidechain'],
  },

  // ── Privacy ───────────────────────────────────────────────────────
  privacy: {
    name: 'Privacy / FHE',
    category: 'privacy',
    tierAffinity: 'lean_conviction',
    keywords: ['privacy', 'confidential', 'FHE', 'MPC', 'encrypted'],
  },

  // ── Consumer ──────────────────────────────────────────────────────
  telegram: {
    name: 'Telegram / TON',
    category: 'consumer',
    tierAffinity: 'strong_moonshot',
    keywords: ['TON', 'Telegram', 'mini app', 'tap to earn'],
  },
  consumer: {
    name: 'Consumer dApps',
    category: 'consumer',
    tierAffinity: 'lean_moonshot',
    keywords: ['wallet', 'onboarding', 'consumer crypto', 'mobile crypto'],
  },

  // ── Governance ────────────────────────────────────────────────────
  degov: {
    name: 'DAOs / Governance',
    category: 'governance',
    tierAffinity: 'strong_moonshot',
    keywords: ['DAO', 'governance', 'treasury management', 'vote'],
  },

  // ── Green ─────────────────────────────────────────────────────────
  energy: {
    name: 'Energy / Carbon',
    category: 'green',
    tierAffinity: 'strong_moonshot',
    keywords: ['carbon credit', 'energy token', 'REC', 'green crypto', 'ESG'],
  },
};

/**
 * Get a single narrative config by ID. Throws if unknown.
 */
export function getNarrative(id) {
  const n = NARRATIVES[id];
  if (!n) throw new Error(`Unknown narrative: ${id}. Known: ${getAllIds().join(', ')}`);
  return { id, ...n };
}

/**
 * Get all narrative IDs.
 */
export function getAllIds() {
  return Object.keys(NARRATIVES);
}

/**
 * Get narratives filtered by category.
 */
export function getNarrativesByCategory(category) {
  return Object.entries(NARRATIVES)
    .filter(([, n]) => n.category === category)
    .map(([id, n]) => ({ id, ...n }));
}

/**
 * Get all unique category names.
 */
export function getCategories() {
  return [...new Set(Object.values(NARRATIVES).map((n) => n.category))];
}

/**
 * Get narratives by tier affinity.
 */
export function getNarrativesByAffinity(affinity) {
  return Object.entries(NARRATIVES)
    .filter(([, n]) => n.tierAffinity === affinity)
    .map(([id, n]) => ({ id, ...n }));
}

/**
 * Build a flat keyword-to-narrative-id map for legacy compatibility.
 * Returns { narrativeId: [keyword1, keyword2, ...] }
 */
export function getKeywordMap() {
  const map = {};
  for (const [id, n] of Object.entries(NARRATIVES)) {
    map[id] = n.keywords;
  }
  return map;
}
