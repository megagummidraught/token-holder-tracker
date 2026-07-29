import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const InputSchema = z.object({
  mint: z.string().trim().min(32).max(64),
  topN: z.number().int().min(5).max(30).default(20),
});

// Well-known CEX / router hot wallets to skip.
const EXCHANGE_WALLETS = new Set<string>([
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", // Binance 1
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", // Binance 2
  "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS", // Coinbase 1
  "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S", // Coinbase 2
  "AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2", // Bybit
  "5PAhQiYdLBd6SVdpzBhpBqR3myruoQZvGjjrKKp5nGmC", // OKX
  "F37Wb3pDGpXKLrTsBVJTJ7RTgFYcpVdY2FiFvW3s9RY6", // Kraken
  "GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE", // Gate
  "6QJzieMYfp7yr3EdrePaQoG3Ghxs2wM98xSLRu8Xh56U", // KuCoin
]);

interface LargestAccount { address: string; uiAmount: number }

const RPC = (key: string) => `https://mainnet.helius-rpc.com/?api-key=${key}`;

async function rpc<T>(key: string, method: string, params: unknown[]): Promise<T | null> {
  const res = await fetch(RPC(key), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { result?: T };
  return j.result ?? null;
}

async function getTokenSupply(key: string, mint: string): Promise<number> {
  const r = await rpc<{ value: { uiAmount: number | null } }>(key, "getTokenSupply", [mint]);
  return r?.value.uiAmount ?? 0;
}

async function getLargestAccounts(key: string, mint: string): Promise<LargestAccount[]> {
  const r = await rpc<{ value: Array<{ address: string; uiAmount: number | null }> }>(
    key,
    "getTokenLargestAccounts",
    [mint],
  );
  return (r?.value ?? []).map((v) => ({ address: v.address, uiAmount: v.uiAmount ?? 0 }));
}

async function getOwner(key: string, tokenAccount: string): Promise<string | null> {
  const r = await rpc<{
    value: { data: { parsed: { info: { owner: string } } } } | null;
  }>(key, "getAccountInfo", [tokenAccount, { encoding: "jsonParsed" }]);
  return r?.value?.data?.parsed?.info?.owner ?? null;
}

interface Signature { signature: string; blockTime: number | null }
async function getSignatures(key: string, wallet: string, limit: number): Promise<Signature[]> {
  const r = await rpc<Array<{ signature: string; blockTime: number | null }>>(
    key,
    "getSignaturesForAddress",
    [wallet, { limit }],
  );
  return r ?? [];
}

interface TxMeta {
  meta?: {
    preTokenBalances?: Array<{ accountIndex: number; mint: string; owner: string; uiTokenAmount: { uiAmount: number | null } }>;
    postTokenBalances?: Array<{ accountIndex: number; mint: string; owner: string; uiTokenAmount: { uiAmount: number | null } }>;
  };
}
async function getTx(key: string, sig: string): Promise<TxMeta | null> {
  return await rpc<TxMeta>(key, "getTransaction", [
    sig,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);
}

function convictionScore(bought: number, sold: number, buyTxs: number, sellTxs: number): number {
  const totalVol = bought + sold;
  const totalTxs = buyTxs + sellTxs;
  if (totalVol === 0 && totalTxs === 0) return 0;
  const volScore = totalVol > 0 ? ((bought - sold) / totalVol) * 100 : 0;
  const txScore = totalTxs > 0 ? ((buyTxs - sellTxs) / totalTxs) * 100 : 0;
  return Math.round((volScore * 0.7 + txScore * 0.3) * 10) / 10;
}

export function scoreLabel(s: number): string {
  if (s >= 70) return "🟢 Strong Accumulation";
  if (s >= 35) return "🟩 Accumulating";
  if (s >= 10) return "🔵 Slight Buying";
  if (s > -10) return "⚪ Neutral / Mixed";
  if (s > -35) return "🟡 Slight Selling";
  if (s > -70) return "🟠 Distributing";
  return "🔴 Heavy Distribution";
}

export type WhaleBucket = "1d" | "2d" | "7d";

export interface WhalePressureResult {
  mint: string;
  scannedWallets: number;
  skippedExchange: number;
  windows: Record<WhaleBucket, {
    aggregateScore: number;
    label: string;
    buying: number;
    selling: number;
    neutral: number;
  }>;
  wallets: Array<{
    address: string;
    pctSupply: number;
    perWindow: Record<WhaleBucket, {
      bought: number; sold: number; net: number; buyTxs: number; sellTxs: number; score: number;
    }>;
  }>;
}

const WINDOWS: Record<WhaleBucket, number> = { "1d": 86400, "2d": 2 * 86400, "7d": 7 * 86400 };
const SIG_LIMIT_PER_WALLET = 80;
const TX_CONCURRENCY = 6;
const WALLET_CONCURRENCY = 4;

export interface WhalePressureOptions {
  signatureLimitPerWallet?: number;
  txConcurrency?: number;
  walletConcurrency?: number;
}

async function scanWallet(
  key: string,
  wallet: string,
  mint: string,
  now: number,
  signatureLimit: number,
  txConcurrency: number,
): Promise<Array<{ delta: number; ts: number }>> {
  const sigs = await getSignatures(key, wallet, signatureLimit);
  const cutoff7d = now - WINDOWS["7d"];
  const inWindow = sigs.filter((s) => (s.blockTime ?? 0) >= cutoff7d);
  const flows: Array<{ delta: number; ts: number }> = [];

  let idx = 0;
  async function worker() {
    while (idx < inWindow.length) {
      const i = idx++;
      const s = inWindow[i];
      const tx = await getTx(key, s.signature);
      if (!tx?.meta) continue;
      const pre = new Map<number, { mint: string; owner: string; uiAmount: number }>();
      const post = new Map<number, { mint: string; owner: string; uiAmount: number }>();
      for (const e of tx.meta.preTokenBalances ?? []) {
        pre.set(e.accountIndex, { mint: e.mint, owner: e.owner, uiAmount: e.uiTokenAmount.uiAmount ?? 0 });
      }
      for (const e of tx.meta.postTokenBalances ?? []) {
        post.set(e.accountIndex, { mint: e.mint, owner: e.owner, uiAmount: e.uiTokenAmount.uiAmount ?? 0 });
      }
      const indices = new Set([...pre.keys(), ...post.keys()]);
      for (const idx2 of indices) {
        const p = pre.get(idx2);
        const q = post.get(idx2);
        const m = q?.mint ?? p?.mint;
        const o = q?.owner ?? p?.owner;
        if (m !== mint || o !== wallet) continue;
        const delta = (q?.uiAmount ?? 0) - (p?.uiAmount ?? 0);
        if (delta !== 0) flows.push({ delta, ts: s.blockTime ?? 0 });
      }
    }
  }
  await Promise.all(Array.from({ length: txConcurrency }, worker));
  return flows;
}

export async function analyzeWhalePressureImpl(
  mint: string,
  topN: number,
  options: WhalePressureOptions = {},
): Promise<WhalePressureResult> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error("HELIUS_API_KEY not configured");
  const heliusKey = key;
  const signatureLimit = options.signatureLimitPerWallet ?? SIG_LIMIT_PER_WALLET;
  const txConcurrency = options.txConcurrency ?? TX_CONCURRENCY;
  const walletConcurrency = options.walletConcurrency ?? WALLET_CONCURRENCY;

  const [supply, largest] = await Promise.all([
    getTokenSupply(heliusKey, mint),
    getLargestAccounts(heliusKey, mint),
  ]);
  if (supply <= 0) throw new Error("Could not fetch token supply");
  if (largest.length === 0) throw new Error("No holder data returned");

  const holders: Array<{ owner: string; balance: number; pctSupply: number }> = [];
  let skippedExchange = 0;

  const owners = await Promise.all(
    largest.slice(0, topN).map(async (h) => {
      const owner = await getOwner(heliusKey, h.address);
      return owner ? { owner, balance: h.uiAmount, pct: (h.uiAmount / supply) * 100 } : null;
    }),
  );
  for (const o of owners) {
    if (!o) continue;
    if (EXCHANGE_WALLETS.has(o.owner)) { skippedExchange++; continue; }
    holders.push({ owner: o.owner, balance: o.balance, pctSupply: o.pct });
  }
  if (holders.length === 0) {
    return {
      mint,
      scannedWallets: 0,
      skippedExchange,
      windows: {
        "1d": { aggregateScore: 0, label: scoreLabel(0), buying: 0, selling: 0, neutral: 0 },
        "2d": { aggregateScore: 0, label: scoreLabel(0), buying: 0, selling: 0, neutral: 0 },
        "7d": { aggregateScore: 0, label: scoreLabel(0), buying: 0, selling: 0, neutral: 0 },
      },
      wallets: [],
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const walletFlows: Record<string, Array<{ delta: number; ts: number }>> = {};

  let widx = 0;
  async function wworker() {
    while (widx < holders.length) {
      const i = widx++;
      const h = holders[i];
      try {
        walletFlows[h.owner] = await scanWallet(
          heliusKey,
          h.owner,
          mint,
          now,
          signatureLimit,
          txConcurrency,
        );
      } catch {
        walletFlows[h.owner] = [];
      }
    }
  }
  await Promise.all(Array.from({ length: walletConcurrency }, wworker));

  const walletResults = holders.map((h) => {
    const flows = walletFlows[h.owner] ?? [];
    const perWindow = {} as WhalePressureResult["wallets"][number]["perWindow"];
    for (const w of ["1d", "2d", "7d"] as WhaleBucket[]) {
      const cutoff = now - WINDOWS[w];
      const rel = flows.filter((f) => f.ts >= cutoff);
      const bought = rel.filter((f) => f.delta > 0).reduce((a, f) => a + f.delta, 0);
      const sold = rel.filter((f) => f.delta < 0).reduce((a, f) => a + Math.abs(f.delta), 0);
      const buyTxs = rel.filter((f) => f.delta > 0).length;
      const sellTxs = rel.filter((f) => f.delta < 0).length;
      perWindow[w] = {
        bought: Math.round(bought * 100) / 100,
        sold: Math.round(sold * 100) / 100,
        net: Math.round((bought - sold) * 100) / 100,
        buyTxs,
        sellTxs,
        score: convictionScore(bought, sold, buyTxs, sellTxs),
      };
    }
    return { address: h.owner, pctSupply: Math.round(h.pctSupply * 10000) / 10000, perWindow };
  });

  const windows = {} as WhalePressureResult["windows"];
  for (const w of ["1d", "2d", "7d"] as WhaleBucket[]) {
    const scores = walletResults.map((r) => r.perWindow[w].score);
    const agg = scores.length
      ? Math.round((scores.reduce((a, s) => a + s, 0) / scores.length) * 10) / 10
      : 0;
    const buying = walletResults.filter((r) => r.perWindow[w].net > 0).length;
    const selling = walletResults.filter((r) => r.perWindow[w].net < 0).length;
    windows[w] = {
      aggregateScore: agg,
      label: scoreLabel(agg),
      buying,
      selling,
      neutral: walletResults.length - buying - selling,
    };
  }

  return {
    mint,
    scannedWallets: holders.length,
    skippedExchange,
    windows,
    wallets: walletResults,
  };
}

export const analyzeWhalePressure = createServerFn({ method: "POST" })
  .inputValidator((input) => InputSchema.parse(input))
  .handler(async ({ data }) => analyzeWhalePressureImpl(data.mint, data.topN));
