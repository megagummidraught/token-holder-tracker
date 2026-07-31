export interface TokenInfo {
  mint: string;
  name: string | null;
  symbol: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange24h: number | null;
  priceChange1h: number | null;
  pairCreatedAt: number | null;
  dexscreenerUrl: string;
  pairAddress: string | null;
}

interface DsPair {
  chainId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h1?: number; h24?: number };
  pairCreatedAt?: number;
  fdv?: number;
  marketCap?: number;
  url?: string;
}

export async function getTokenInfoImpl(mint: string): Promise<TokenInfo> {
  const dexUrl = `https://dexscreener.com/solana/${mint}`;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!res.ok) throw new Error(`dexscreener ${res.status}`);
    const j = (await res.json()) as { pairs?: DsPair[] };
    const pairs = (j.pairs ?? []).filter((p) => p.chainId === "solana");
    if (pairs.length === 0) {
      return {
        mint,
        name: null,
        symbol: null,
        priceUsd: null,
        marketCapUsd: null,
        liquidityUsd: null,
        volume24hUsd: null,
        priceChange24h: null,
        priceChange1h: null,
        pairCreatedAt: null,
        dexscreenerUrl: dexUrl,
        pairAddress: null,
      };
    }
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const top = pairs[0];
    return {
      mint,
      name: top.baseToken.name,
      symbol: top.baseToken.symbol,
      priceUsd: top.priceUsd ? Number(top.priceUsd) : null,
      marketCapUsd: top.marketCap ?? top.fdv ?? null,
      liquidityUsd: top.liquidity?.usd ?? null,
      volume24hUsd: top.volume?.h24 ?? null,
      priceChange24h: top.priceChange?.h24 ?? null,
      priceChange1h: top.priceChange?.h1 ?? null,
      pairCreatedAt: top.pairCreatedAt ?? null,
      dexscreenerUrl: top.url ?? dexUrl,
      pairAddress: top.pairAddress,
    };
  } catch {
    return {
      mint,
      name: null,
      symbol: null,
      priceUsd: null,
      marketCapUsd: null,
      liquidityUsd: null,
      volume24hUsd: null,
      priceChange24h: null,
      priceChange1h: null,
      pairCreatedAt: null,
      dexscreenerUrl: dexUrl,
      pairAddress: null,
    };
  }
}