const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const WSOL = "So11111111111111111111111111111111111111112";

const MIN_USD = 100;
const MAX_PAGES = 15;
const MAX_HOLDERS_TO_CHECK = 400;
const FETCH_TIMEOUT_MS = 15_000;

export interface AnalysisOptions {
  maxPages?: number;
  maxHoldersToCheck?: number;
}

async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

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
    amount: number;
  }>;
  signature: string;
}

async function fetchJupPrices(mints: string[]): Promise<Record<string, number>> {
  const ids = Array.from(new Set(mints)).join(",");
  try {
    const res = await fetchWithTimeout(`https://lite-api.jup.ag/price/v3?ids=${ids}`);
    if (!res.ok) return {};
    const j = (await res.json()) as Record<string, { usdPrice?: number } | null>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(j)) {
      const p = v?.usdPrice ?? 0;
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
): Promise<{ txs: HeliusTx[]; nextBefore?: string }> {
  const url = new URL(`https://api.helius.xyz/v0/addresses/${mint}/transactions`);
  url.searchParams.set("api-key", apiKey);
  url.searchParams.set("type", "SWAP");
  url.searchParams.set("limit", "100");
  if (before) url.searchParams.set("before", before);
  const res = await fetchWithTimeout(url);
  if (res.status === 404) {
    const body = await res.text();
    const m = body.match(/before-signature[^A-Za-z0-9]+([1-9A-HJ-NP-Za-km-z]{32,})/);
    return { txs: [], nextBefore: m?.[1] };
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Helius tx fetch failed [${res.status}]: ${body.slice(0, 200)}`);
  }
  const txs = (await res.json()) as HeliusTx[];
  return { txs, nextBefore: txs.length ? txs[txs.length - 1].signature : undefined };
}

async function getCurrentBalance(
  apiKey: string,
  owner: string,
  mint: string,
): Promise<number> {
  const res = await fetchWithTimeout(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
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

export type Grade = "A+" | "A" | "B" | "C" | "D" | "F";

export interface AnalysisResult {
  mint: string;
  tokenPriceUsd: number;
  solPriceUsd: number;
  scannedTransactions: number;
  oldestScannedTimestamp: number | null;
  reachedWindowEnd: boolean;
  excludedLpLike: number;
  grade: Grade;
  gradeScore: number;
  gradeReason: string;
  buckets: Record<Bucket, {
    qualifyingBuyers: number;
    stillHolding: number;
    buyers: Array<{ address: string; usdBought: number; currentUsd: number }>;
  }>;
}

export async function analyzeTokenImpl(
  mint: string,
  options: AnalysisOptions = {},
): Promise<AnalysisResult> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("HELIUS_API_KEY not configured");
  const heliusKey: string = apiKey;

  const prices = await fetchJupPrices([mint, WSOL]);
  const tokenPrice = prices[mint] ?? 0;
  const solPrice = prices[WSOL] ?? 0;
  if (!solPrice) throw new Error("Failed to fetch SOL price from Jupiter");
  if (!tokenPrice) throw new Error("Failed to fetch token price from Jupiter (is this a tradable mint?)");

  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - WINDOWS["7d"];
  const buyerBuys = new Map<string, { u1: number; u2: number; u7: number }>();
  const sellerSells = new Map<string, { usd: number; count: number }>();
  let before: string | undefined;
  let scanned = 0;
  let oldestTs: number | null = null;
  let reachedEnd = false;
  const maxPages = options.maxPages ?? MAX_PAGES;
  const maxHoldersToCheck = options.maxHoldersToCheck ?? MAX_HOLDERS_TO_CHECK;

  for (let page = 0; page < maxPages; page++) {
    const { txs, nextBefore } = await fetchSwapPage(mint, heliusKey, before);
    if (txs.length === 0 && !nextBefore) {
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
      const mintTransfers = (tx.tokenTransfers ?? []).filter((t) => t.mint === mint && t.tokenAmount > 0);
      if (mintTransfers.length === 0) continue;
      const receives = mintTransfers.filter((t) => t.toUserAccount);
      const sends = mintTransfers.filter((t) => t.fromUserAccount);

      if (sends.length > 0) {
        sends.sort((a, b) => b.tokenAmount - a.tokenAmount);
        const seller = sends[0].fromUserAccount;
        if (seller) {
          const usdSold = sends[0].tokenAmount * tokenPrice;
          const s = sellerSells.get(seller) ?? { usd: 0, count: 0 };
          s.usd += usdSold;
          s.count += 1;
          sellerSells.set(seller, s);
        }
      }

      if (receives.length === 0) continue;
      receives.sort((a, b) => b.tokenAmount - a.tokenAmount);
      const buyer = receives[0].toUserAccount;
      if (!buyer) continue;
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
      rec.u7 += usdPaid;
      buyerBuys.set(buyer, rec);
    }
    before = nextBefore;
    if (!before) {
      reachedEnd = true;
      break;
    }
    if (txs.length > 0 && txs[txs.length - 1].timestamp < cutoff) {
      reachedEnd = true;
      break;
    }
  }

  function isLpLike(addr: string): boolean {
    const s = sellerSells.get(addr);
    if (!s) return false;
    if (s.count >= 3) return true;
    const bought = buyerBuys.get(addr);
    const boughtUsd = bought?.u7 ?? 0;
    if (boughtUsd > 0 && s.usd >= boughtUsd * 0.5) return true;
    if (!bought && s.usd >= 10_000) return true;
    return false;
  }

  let excludedLpLike = 0;
  for (const addr of Array.from(buyerBuys.keys())) {
    if (isLpLike(addr)) {
      buyerBuys.delete(addr);
      excludedLpLike++;
    }
  }

  const qual: Record<Bucket, string[]> = { "1d": [], "2d": [], "7d": [] };
  for (const [addr, r] of buyerBuys.entries()) {
    if (r.u1 >= MIN_USD) qual["1d"].push(addr);
    if (r.u2 >= MIN_USD) qual["2d"].push(addr);
    if (r.u7 >= MIN_USD) qual["7d"].push(addr);
  }

  const uniqueBuyers = Array.from(
    new Set([...qual["1d"], ...qual["2d"], ...qual["7d"]]),
  ).slice(0, maxHoldersToCheck);
  const balanceUsd = new Map<string, number>();
  let idx = 0;
  async function worker() {
    while (idx < uniqueBuyers.length) {
      const i = idx++;
      const addr = uniqueBuyers[i];
      if (!addr) continue;
      try {
        const bal = await getCurrentBalance(heliusKey, addr, mint);
        balanceUsd.set(addr, bal * tokenPrice);
      } catch {
        balanceUsd.set(addr, 0);
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));

  function build(bucket: Bucket) {
    const buyers = qual[bucket]
      .map((addr) => {
        const buyer = buyerBuys.get(addr);
        if (!buyer) return null;
        return {
          address: addr,
          usdBought: bucket === "1d" ? buyer.u1 : bucket === "2d" ? buyer.u2 : buyer.u7,
          currentUsd: balanceUsd.get(addr) ?? 0,
        };
      })
      .filter((buyer): buyer is { address: string; usdBought: number; currentUsd: number } => buyer != null)
      .sort((a, b) => b.usdBought - a.usdBought);
    return {
      qualifyingBuyers: buyers.length,
      stillHolding: buyers.filter((b) => b.currentUsd >= MIN_USD).length,
      buyers: buyers.slice(0, 50),
    };
  }

  const b1 = build("1d");
  const b2 = build("2d");
  const b7 = build("7d");
  const retention = b7.qualifyingBuyers > 0 ? b7.stillHolding / b7.qualifyingBuyers : 0;
  const volScore = Math.min(1, Math.log10(1 + b7.stillHolding) / 2);
  const score = Math.round((retention * 0.65 + volScore * 0.35) * 100);
  let grade: Grade;
  if (score >= 85) grade = "A+";
  else if (score >= 70) grade = "A";
  else if (score >= 55) grade = "B";
  else if (score >= 40) grade = "C";
  else if (score >= 25) grade = "D";
  else grade = "F";

  return {
    mint,
    tokenPriceUsd: tokenPrice,
    solPriceUsd: solPrice,
    scannedTransactions: scanned,
    oldestScannedTimestamp: oldestTs,
    reachedWindowEnd: reachedEnd,
    excludedLpLike,
    grade,
    gradeScore: score,
    gradeReason: `${b7.stillHolding}/${b7.qualifyingBuyers} 7d buyers still hold $100+ (${Math.round(retention * 100)}% retention)`,
    buckets: { "1d": b1, "2d": b2, "7d": b7 },
  };
}