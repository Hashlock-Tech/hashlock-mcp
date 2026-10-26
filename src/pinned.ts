/**
 * WHAT THIS RELEASE WILL SETTLE THROUGH AND IN (tester 3.4). The API names the factory, pool or program a
 * leg settles through and the token an asset id stands for; an agent that takes that on the API's word
 * hands a compromised or mistaken API its money. So every contract the agent sends value to or reads an
 * escrow from, and every asset it settles in, is listed here PER NETWORK — and the network is the one the
 * agent's own RPC answers for (EVM chain id, TRON/Solana genesis, the Bitcoin key's own network), never
 * the API's say-so. A new deployment or asset reaches agents through a release, not through /config.
 *
 * Each network has the CURRENT contracts, the only ones new money goes into (`fund`), and every contract
 * whose escrows may still be read and claimed (`all` = current + retired). A rotation MOVES the old
 * address from `fund` to the retired part of `all` — never just deletes it.
 *
 * Sources: mainnet — hashlock-markets README "Chains and contracts (mainnet)", the staging/production
 * GitHub variables and the production asset registry's curated (verified) rows, checked against each
 * token's well-known address; testnets — the dev variables, the 2026-10 remediation roadmap and the dev
 * registry's curated rows.
 */

export type Net = 'mainnet' | 'testnet';

/** A token this release settles in: its symbol and decimals (the address is the key it is listed under). */
export interface PinnedToken {
  symbol: string;
  decimals: number;
}

export interface Rail {
  fund: string[];
  all: string[];
  /** Tokens by address (EVM lower-case; TRON/Solana base58 as written). The native coin is always allowed. */
  tokens: Record<string, PinnedToken>;
}

const t = (symbol: string, decimals: number): PinnedToken => ({ symbol, decimals });
const lower = (m: Record<string, PinnedToken>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k.toLowerCase(), v]));

const MAINNET_FACTORY = '0xa9B6a64837259034E949787B5d17Bfa46304ff71';
// TODO(mainnet): once the owner deploys the QuillAudits round-3 contracts, put them in `fund` (and `all`)
// and keep 0xa9B6… / TE97… / 7Egs… in `all` only.

/** Per EVM chain id. */
export const EVM: Record<number, Rail> = {
  1: {
    fund: [MAINNET_FACTORY],
    all: [MAINNET_FACTORY],
    tokens: lower({
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': t('USDC', 6),
      '0xdAC17F958D2ee523a2206206994597C13D831ec7': t('USDT', 6),
      '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': t('WBTC', 8),
    }),
  },
  8453: {
    fund: [MAINNET_FACTORY],
    all: [MAINNET_FACTORY],
    tokens: lower({
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': t('USDC', 6),
      '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2': t('USDT', 6),
    }),
  },
  4663: {
    fund: [MAINNET_FACTORY],
    all: [MAINNET_FACTORY],
    tokens: lower({ '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168': t('USDG', 6) }),
  },
  11155111: {
    fund: ['0x442c8d7616836470Dace4f3eEF9Ada3B24d18Abf'], // 2026-10-26 round 3
    all: [
      '0x442c8d7616836470Dace4f3eEF9Ada3B24d18Abf',
      '0x0e4565a5d87f5ab61074D1bD019630ef6555D726', // 2026-09-15
      '0x97721f9e82fA046c3c365a5572b7d2fb33a1F3Fa', // older, 7-argument computeAddress
    ],
    tokens: lower({
      '0x14E932194809eDF8a0BD1F98B99F6A85845A20A4': t('USDT', 6),
      '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238': t('USDC', 6),
      '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4': t('EURC', 6),
      '0x779877A7B0D9E8603169DdbD7836e478b4624789': t('LINK', 18),
      '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14': t('WETH', 18),
    }),
  },
  84532: {
    fund: ['0x9c979Cb4E89C93eDcF4D630Da9B479D948d29F4F'],
    all: ['0x9c979Cb4E89C93eDcF4D630Da9B479D948d29F4F'],
    tokens: lower({
      '0x9849E6933708782C75aD3Cc182856F004f4c6C8B': t('mUSD', 6),
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e': t('USDC', 6),
      '0x808456652fdb597867f38412077A9182bf77359F': t('EURC', 6),
      '0x4200000000000000000000000000000000000006': t('WETH', 18),
    }),
  },
  46630: {
    fund: ['0x273Ec18241286014060F46F4CaC9364209C28650'],
    all: ['0x273Ec18241286014060F46F4CaC9364209C28650'],
    tokens: lower({ '0x8B53B9e8ef71C63e2141D8A7B872Df680Ca7B0eF': t('mUSD', 6) }),
  },
};

/** SharedHTLC pools and TRC-20s, per network (mainnet / Nile). */
export const TRON: Record<Net, Rail> = {
  mainnet: {
    fund: ['TE97fe1beR5nRZzjixi4azE36qWcHEWmNj'], // v2
    all: ['TE97fe1beR5nRZzjixi4azE36qWcHEWmNj', 'TAyJCZ9a5uszYZw2Rt4RMLpJCQqQGhSz1p' /* v1, retired */],
    tokens: { TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: t('USDT', 6) },
  },
  testnet: {
    fund: ['TQRHZmUjnNeSadw2d3R7W1gqinwQyQ77Kk'], // 2026-10-26 round 3
    all: [
      'TQRHZmUjnNeSadw2d3R7W1gqinwQyQ77Kk',
      'TTgyfho2Aj4Gc5edbfwoPspHgvNgkp2BKQ', // before round 3
      'TCfSy1B5EoKXPztvUWEqHZTyLjY2mnLo1b', // 2026-09-15
      'TCx9hPy3YGq5jdgA636dZs8PhhZJA257sy',
      'TULwQLtPrq8ie3Qg3zLLBT9wKFara6Eco3',
    ],
    tokens: { TLjTS6iKGdJq7NmLqkph2noissPxjQxk2y: t('USDT', 6) },
  },
};

/** HTLC programs and SPL mints, per network (mainnet / devnet). The markets repo's pda.ts DEPLOYED list. */
export const SOLANA: Record<Net, Rail> = {
  mainnet: {
    fund: ['7Egsecq7YU5n7PonndM7W7W92EFLZVGrnoaNPW8n1DEc'], // 2026-10-12, immutable
    all: ['7Egsecq7YU5n7PonndM7W7W92EFLZVGrnoaNPW8n1DEc'],
    tokens: {
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: t('USDC', 6),
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: t('USDT', 6),
    },
  },
  testnet: {
    fund: ['721JrU7NUvaRBSz3JGyuJQMZMgKrT28aonEGxzngMemf'], // round 3, 2026-10-26
    all: ['721JrU7NUvaRBSz3JGyuJQMZMgKrT28aonEGxzngMemf', '7Egsecq7YU5n7PonndM7W7W92EFLZVGrnoaNPW8n1DEc' /* retired on devnet */],
    tokens: {
      '8AMDXWQRk5tK4LRQzfiBbXaZyNjpwBoTwmr6Q89FTnY4': t('USDT', 6),
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': t('USDC', 6),
    },
  },
};

/**
 * Bitcoin: where the protocol fee may be paid, and how deep a counterparty's escrow must be before the
 * agent funds against it (the API's own `confirmations` for the network).
 */
export const BITCOIN: Record<Net, { treasury: string; confirmations: number }> = {
  mainnet: { treasury: 'bc1q0sz4jm5yf60st2ecc00yyw5nxd673m5njcf2fdnc9wqv2mls0l3q085d9u', confirmations: 3 },
  testnet: { treasury: 'tb1q8qykj727kz65cjzsukg0ql76u7yet6vwnwgpgh', confirmations: 1 },
};

/** Genesis identifiers the agent's own TRON host / Solana RPC answer with, per network. */
export const TRON_GENESIS: Record<string, Net> = {
  '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc': 'mainnet',
  '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc': 'testnet', // Nile
};
export const SOLANA_GENESIS: Record<string, Net> = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet',
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: 'testnet', // devnet
};

export const NATIVE_DECIMALS = { evm: 18, tron: 6, svm: 9, btc: 8 } as const;
/** The native coin's symbol per family (every EVM chain this release settles on uses ETH). */
export const NATIVE_SYMBOL = { evm: 'ETH', tron: 'TRX', svm: 'SOL', btc: 'BTC' } as const;

/**
 * The most protocol fee a leg may carry, in basis points of that leg (production charges 8). A ceiling, not
 * the rate: the agent cannot know the agreed rate except from the API, so it refuses only an overcharge.
 */
export const MAX_FEE_BPS = 30n;

/** The longest any leg may be locked from now: the 24h Bitcoin default + the 2h gap, plus an hour of slack. */
export const MAX_TIMELOCK_SECONDS = 27 * 3600;

/**
 * A pinned asset of a family on any of its networks (null address = the native coin), or null — for reading
 * decimals before the network is known. A registry symbol that is not the pinned one is refused: the symbol
 * is what the agent decides on, so a registry naming the pinned USDT address "WBTC" is lying about the deal.
 */
export function pinnedAsset(family: 'evm' | 'tron' | 'svm' | 'btc', address: string | null, symbol: string): PinnedToken | null {
  let hit: PinnedToken | null = null;
  if (address === null) hit = { symbol: NATIVE_SYMBOL[family], decimals: NATIVE_DECIMALS[family] };
  else {
    const rails = family === 'evm' ? Object.values(EVM) : family === 'tron' ? Object.values(TRON) : family === 'svm' ? Object.values(SOLANA) : [];
    const key = family === 'evm' ? address.toLowerCase() : address;
    for (const r of rails) if (r.tokens[key]) hit = r.tokens[key]!;
  }
  if (hit && hit.symbol !== symbol) throw new Error(`the registry calls ${address ?? 'the native coin'} "${symbol}", but it is ${hit.symbol} — refusing`);
  return hit;
}
