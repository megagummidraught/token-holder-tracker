import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { analyzeTokenImpl } from "./token-analysis.server";
import { getTokenInfoImpl } from "./token-info.server";
import type { Grade } from "./token-analysis.server";
import { tgSend } from "./telegram";

const STABLES = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

const ALERT_GRADES = new Set<Grade>(["A", "A+"]);
const MIN_LIQUIDITY_USD = 30_000;
const MIN_VOLUME_24H_USD = 100_000;
const RESCAN_AFTER_MS = 6 * 60 * 60 * 1000;
const REALERT_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_SCANS_PER_RUN = 3;
const PER_TOKEN_TIMEOUT_MS = 40_000;
const FETCH_TIMEOUT_MS = 12_000;

export interface Candidate {
  mint: string;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange1h: number | null;
  pairCreatedAt: number | null;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

interface DexPair {
  chainId?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h1?: number };
  pairCreatedAt?: number;
}

interface BoostEntry {
  chainId?: string;
  tokenAddress?: string;
}

/** Pull a pool of active Solana tokens and rank them by 24h volume. */
export async function fetchCandidates(): Promise<Candidate[]> {
  const boostLists = await Promise.all([
    fetchJson<BoostEntry[]>("https://api.dexscreener.com/token-boosts/top/v1"),
    fetchJson<BoostEntry[]>("https://api.dexscreener.com/token-boosts/latest/v1"),
    fetchJson<BoostEntry[]>("https://api.dexscreener.com/token-profiles/latest/v1"),
  ]);

  const mints = new Set<string>();
  for (const list of boostLists) {
    for (const e of list ?? []) {
      if (e.chainId !== "solana") continue;
      const addr = e.tokenAddress;
      if (!addr || STABLES.has(addr)) continue;
      mints.add(addr);
    }
  }

  const all = Array.from(mints);
  const byMint = new Map<string, Candidate>();
  for (let i = 0; i < all.length; i += 30) {
    const chunk = all.slice(i, i + 30);
    const data = await fetchJson<{ pairs?: DexPair[] } | DexPair[]>(
      `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`,
    );
    const pairs: DexPair[] = Array.isArray(data) ? data : (data?.pairs ?? []);
    for (const p of pairs) {
      if (p.chainId !== "solana") continue;
      const addr = p.baseToken?.address;
      if (!addr || !mints.has(addr)) continue;
      const vol = p.volume?.h24 ?? 0;
      const liq = p.liquidity?.usd ?? 0;
      const prev = byMint.get(addr);
      if (prev && (prev.volume24hUsd ?? 0) >= vol) continue;
      byMint.set(addr, {
        mint: addr,
        symbol: p.baseToken?.symbol ?? null,
        name: p.baseToken?.name ?? null,
        priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
        liquidityUsd: liq,
        volume24hUsd: vol,
        priceChange1h: p.priceChange?.h1 ?? null,
        pairCreatedAt: p.pairCreatedAt ?? null,
      });
    }
  }

  return Array.from(byMint.values())
    .filter(
      (c) =>
        (c.liquidityUsd ?? 0) >= MIN_LIQUIDITY_USD &&
        (c.volume24hUsd ?? 0) >= MIN_VOLUME_24H_USD,
    )
    .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]).finally(() => {
    if (t) clearTimeout(t);
  }) as Promise<T>;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "n/a";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(4)}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtAge(ms: number | null | undefined): string {
  if (ms == null) return "n/a";
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 60) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface ScanRunResult {
  candidates: number;
  scanned: string[];
  alerted: string[];
  errors: string[];
}

export async function runScannerPass(): Promise<ScanRunResult> {
  const result: ScanRunResult = { candidates: 0, scanned: [], alerted: [], errors: [] };
  const candidates = await fetchCandidates();
  result.candidates = candidates.length;
  if (candidates.length === 0) return result;

  const mints = candidates.map((c) => c.mint);
  const { data: known } = await supabaseAdmin
    .from("scanner_tokens")
    .select("mint,last_scanned_at,last_alerted_at")
    .in("mint", mints);

  const knownMap = new Map((known ?? []).map((k) => [k.mint, k]));
  const now = Date.now();
  const queue = candidates
    .filter((c) => {
      const k = knownMap.get(c.mint);
      if (!k?.last_scanned_at) return true;
      return now - new Date(k.last_scanned_at).getTime() > RESCAN_AFTER_MS;
    })
    .slice(0, MAX_SCANS_PER_RUN);

  const { data: subs } = await supabaseAdmin
    .from("scanner_subscribers")
    .select("chat_id")
    .eq("enabled", true);
  const chatIds = (subs ?? []).map((s) => Number(s.chat_id));

  for (const c of queue) {
    try {
      const analysis = await withTimeout(
        analyzeTokenImpl(c.mint, { maxPages: 5, maxHoldersToCheck: 100 }),
        PER_TOKEN_TIMEOUT_MS,
        `Scan of ${c.mint}`,
      );
      result.scanned.push(c.mint);

      await supabaseAdmin.from("scanner_tokens").upsert({
        mint: c.mint,
        symbol: c.symbol,
        name: c.name,
        last_grade: analysis.grade,
        last_score: analysis.gradeScore,
        last_scanned_at: new Date().toISOString(),
      });

      if (!ALERT_GRADES.has(analysis.grade)) continue;

      const prevAlert = knownMap.get(c.mint)?.last_alerted_at;
      if (prevAlert && now - new Date(prevAlert).getTime() < REALERT_AFTER_MS) continue;

      await supabaseAdmin.from("scanner_alerts").insert({
        mint: c.mint,
        symbol: c.symbol,
        name: c.name,
        grade: analysis.grade,
        score: analysis.gradeScore,
        price_usd: c.priceUsd,
        liquidity_usd: c.liquidityUsd,
        volume_24h_usd: c.volume24hUsd,
      });
      await supabaseAdmin
        .from("scanner_tokens")
        .update({ last_alerted_at: new Date().toISOString() })
        .eq("mint", c.mint);

      let info: Awaited<ReturnType<typeof getTokenInfoImpl>> | null = null;
      try {
        info = await withTimeout(getTokenInfoImpl(c.mint), 10_000, "Token info");
      } catch {
        info = null;
      }

      const b7 = analysis.buckets["7d"];
      const b1 = analysis.buckets["1d"];
      const text = [
        `🚨 <b>Sticky-buyer alert — Grade ${analysis.grade}</b>`,
        "",
        `<b>${esc(c.name ?? info?.name ?? "Unknown")}</b>${c.symbol ? ` <i>($${esc(c.symbol)})</i>` : ""}`,
        `<code>${esc(c.mint)}</code>`,
        `🔗 <a href="https://dexscreener.com/solana/${c.mint}">DexScreener</a>`,
        "",
        `Score: <b>${analysis.gradeScore}/100</b>`,
        `<i>${esc(analysis.gradeReason)}</i>`,
        `• 1d: ${b1.stillHolding}/${b1.qualifyingBuyers} still hold $100+`,
        `• 7d: ${b7.stillHolding}/${b7.qualifyingBuyers} still hold $100+`,
        "",
        `💵 ${fmtUsd(c.priceUsd)}  💧 Liq ${fmtUsd(c.liquidityUsd)}  🔄 24h ${fmtUsd(c.volume24hUsd)}`,
        `⏱ 1h ${fmtPct(c.priceChange1h ?? info?.priceChange1h)}  🚀 Age ${fmtAge(c.pairCreatedAt ?? info?.pairCreatedAt)}`,
      ].join("\n");

      for (const chatId of chatIds) {
        try {
          await tgSend(chatId, text);
        } catch (err) {
          result.errors.push(`send ${chatId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      result.alerted.push(c.mint);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${c.mint}: ${message}`);
      await supabaseAdmin.from("scanner_tokens").upsert({
        mint: c.mint,
        symbol: c.symbol,
        name: c.name,
        last_scanned_at: new Date().toISOString(),
      });
    }
  }

  return result;
}
