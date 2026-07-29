import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const InputSchema = z.object({ mint: z.string().trim().min(32).max(64) });

export interface TokenInfo {
  mint: string;
  name: string | null;
  symbol: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange24h: number | null;
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
  priceChange?: { h24?: number };
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
        mint, name: null, symbol: null, priceUsd: null, marketCapUsd: null,
        liquidityUsd: null, volume24hUsd: null, priceChange24h: null,
        dexscreenerUrl: dexUrl, pairAddress: null,
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
      dexscreenerUrl: top.url ?? dexUrl,
      pairAddress: top.pairAddress,
    };
  } catch {
    return {
      mint, name: null, symbol: null, priceUsd: null, marketCapUsd: null,
      liquidityUsd: null, volume24hUsd: null, priceChange24h: null,
      dexscreenerUrl: dexUrl, pairAddress: null,
    };
  }
}

export const getTokenInfo = createServerFn({ method: "POST" })
  .inputValidator((input) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<TokenInfo> => getTokenInfoImpl(data.mint));
