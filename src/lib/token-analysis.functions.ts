import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const WSOL = "So11111111111111111111111111111111111111112";

const MIN_USD = 100;
const MAX_PAGES = 15; // 100 tx/page => up to 1500 recent swaps
const MAX_HOLDERS_TO_CHECK = 400;

const InputSchema = z.object({
  mint: z.string().trim().min(32).max(64),
});

type Bucket = "1d" | "2d" | "7d";
const WINDOWS: Record<Bucket, number> = {
  "1d": 86400,
  "2d": 2 * 86400,
  "7d": 7 * 86400,
};

interface HeliusTx {
  timestamp: number;
  tokenTransfers?: Array<{
    fromUserAccount?: string | null;
    toUserAccount?: string | null;
    mint: string;
    tokenAmount: number;
  }>;
  nativeTransfers?: Array<{
    fromUserAccount?: string | null;
    toUserAccount?: string | null;
    amount: number; // lamports
  }>;
  signature: string;
}

async function fetchJupPrices(mints: string[]): Promise<Record<string, number>> {
  const ids = Array.from(new Set(mints)).join(",");
  try {
    const res = await fetch(`https://api.jup.ag/price/v2?ids=${ids}`);
    if (!res.ok) return {};
    const j = (await res.json()) as { data?: Record<string, { price?: string } | null> };
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(j.data ?? {})) {
      const p = v?.price ? parseFloat(v.price) : 0;
      if (p > 0) out[k] = p;
    }
    return out;
  } catch {
    return {};
  }
}

async function fetchSwapPage(
  mint: string,
  apiKey: string,
  before?: string,
): Promise<HeliusTx[]> {
  const url = new URL(`https://api.helius.xyz/v0/addresses/${mint}/transactions`);
  url.searchParams.set("api-key", apiKey);
  url.searchParams.set("type", "SWAP");
  url.searchParams.set("limit", "100");
  if (before) url.searchParams.set("before", before);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Helius tx fetch failed [${res.status}]: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as HeliusTx[];
}

async function getCurrentBalance(
  apiKey: string,
  owner: string,
  mint: string,
): Promise<number> {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [owner, { mint }, { encoding: "jsonParsed" }],
    }),
  });
  if (!res.ok) return 0;
  const j = (await res.json()) as {
    result?: {
      value?: Array<{
        account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } };
      }>;
    };
  };
  let total = 0;
  for (const v of j.result?.value ?? []) {
    total += v.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
  }
  return total;
}

export interface AnalysisResult {
  mint: string;
  tokenPriceUsd: number;
  solPriceUsd: number;
  scannedTransactions: number;
  oldestScannedTimestamp: number | null;
  reachedWindowEnd: boolean;
  buckets: Record<Bucket, {
    qualifyingBuyers: number;
    stillHolding: number;
    buyers: Array<{ address: string; usdBought: number; currentUsd: number }>;
  }>;
}

export const analyzeToken = createServerFn({ method: "POST" })
  .inputValidator((input) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<AnalysisResult> => {
    const apiKeyEnv = process.env.HELIUS_API_KEY;
    if (!apiKeyEnv) throw new Error("HELIUS_API_KEY not configured");
    const apiKey: string = apiKeyEnv;
    const mint = data.mint;


    const prices = await fetchJupPrices([mint, WSOL]);
    const tokenPrice = prices[mint] ?? 0;
    const solPrice = prices[WSOL] ?? 0;
    if (!solPrice) throw new Error("Failed to fetch SOL price from Jupiter");
    if (!tokenPrice) throw new Error("Failed to fetch token price from Jupiter (is this a tradable mint?)");

    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - WINDOWS["7d"];

    // Accumulate first-buy events per (bucket, buyer): sum usd bought within window
    // buyerBuys[address] = { firstTs, totalUsdIn7d, totalUsdIn2d, totalUsdIn1d }
    const buyerBuys = new Map<string, { u1: number; u2: number; u7: number }>();

    let before: string | undefined;
    let scanned = 0;
    let oldestTs: number | null = null;
    let reachedEnd = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      const txs = await fetchSwapPage(mint, apiKey, before);
      if (txs.length === 0) {
        reachedEnd = true;
        break;
      }
      scanned += txs.length;
      for (const tx of txs) {
        oldestTs = tx.timestamp;
        if (tx.timestamp < cutoff) {
          reachedEnd = true;
          continue;
        }
        // Identify buyer: account that received the target mint
        const receives = (tx.tokenTransfers ?? []).filter(
          (t) => t.mint === mint && t.toUserAccount && t.tokenAmount > 0,
        );
        if (receives.length === 0) continue;
        // Use largest receiver as buyer
        receives.sort((a, b) => b.tokenAmount - a.tokenAmount);
        const buyer = receives[0].toUserAccount!;

        // USD paid = SOL sent by buyer * solPrice + USDC/USDT sent by buyer
        let usdPaid = 0;
        for (const n of tx.nativeTransfers ?? []) {
          if (n.fromUserAccount === buyer) usdPaid += (n.amount / 1e9) * solPrice;
        }
        for (const t of tx.tokenTransfers ?? []) {
          if (t.fromUserAccount !== buyer) continue;
          if (t.mint === USDC || t.mint === USDT) usdPaid += t.tokenAmount;
          else if (t.mint === WSOL) usdPaid += t.tokenAmount * solPrice;
        }
        if (usdPaid < MIN_USD) continue;

        const rec = buyerBuys.get(buyer) ?? { u1: 0, u2: 0, u7: 0 };
        const age = now - tx.timestamp;
        if (age <= WINDOWS["1d"]) rec.u1 += usdPaid;
        if (age <= WINDOWS["2d"]) rec.u2 += usdPaid;
        rec.u7 += usdPaid; // within 7d because of cutoff
        buyerBuys.set(buyer, rec);
      }
      const last = txs[txs.length - 1];
      before = last.signature;
      if (last.timestamp < cutoff) {
        reachedEnd = true;
        break;
      }
    }

    // Aggregate qualifying buyers per bucket (usd >= 100 in that window)
    const qual: Record<Bucket, string[]> = { "1d": [], "2d": [], "7d": [] };
    for (const [addr, r] of buyerBuys.entries()) {
      if (r.u1 >= MIN_USD) qual["1d"].push(addr);
      if (r.u2 >= MIN_USD) qual["2d"].push(addr);
      if (r.u7 >= MIN_USD) qual["7d"].push(addr);
    }

    // Union of all buyers to check current holdings (cap for cost/perf)
    const uniqueBuyers = Array.from(
      new Set([...qual["1d"], ...qual["2d"], ...qual["7d"]]),
    ).slice(0, MAX_HOLDERS_TO_CHECK);

    const balanceUsd = new Map<string, number>();
    // Limit concurrency
    const CONCURRENCY = 8;
    let idx = 0;
    async function worker() {
      while (idx < uniqueBuyers.length) {
        const i = idx++;
        const addr = uniqueBuyers[i];
        try {
          const bal = await getCurrentBalance(apiKey, addr, mint);
          balanceUsd.set(addr, bal * tokenPrice);
        } catch {
          balanceUsd.set(addr, 0);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    function build(bucket: Bucket) {
      const buyers = qual[bucket]
        .map((addr) => ({
          address: addr,
          usdBought:
            bucket === "1d"
              ? buyerBuys.get(addr)!.u1
              : bucket === "2d"
                ? buyerBuys.get(addr)!.u2
                : buyerBuys.get(addr)!.u7,
          currentUsd: balanceUsd.get(addr) ?? 0,
        }))
        .sort((a, b) => b.usdBought - a.usdBought);
      const stillHolding = buyers.filter((b) => b.currentUsd >= MIN_USD).length;
      return {
        qualifyingBuyers: buyers.length,
        stillHolding,
        buyers: buyers.slice(0, 50),
      };
    }

    return {
      mint,
      tokenPriceUsd: tokenPrice,
      solPriceUsd: solPrice,
      scannedTransactions: scanned,
      oldestScannedTimestamp: oldestTs,
      reachedWindowEnd: reachedEnd,
      buckets: {
        "1d": build("1d"),
        "2d": build("2d"),
        "7d": build("7d"),
      },
    };
  });
