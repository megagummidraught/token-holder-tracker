import type { AnalysisResult } from "@/lib/token-analysis.functions";
import type { WhalePressureResult, WhaleBucket } from "@/lib/whale-pressure.functions";
import type { TokenInfo } from "@/lib/token-info.functions";

const GATEWAY = "https://connector-gateway.lovable.dev/telegram";
const TELEGRAM_SEND_TIMEOUT_MS = 12_000;

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function tgSend(chatId: number, text: string, extra?: Record<string, unknown>) {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const tgKey = process.env.TELEGRAM_API_KEY;
  if (!lovableKey || !tgKey) throw new Error("Telegram env vars missing");
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${GATEWAY}/sendMessage`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lovableKey}`,
          "X-Connection-Api-Key": tgKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          ...extra,
        }),
      },
      TELEGRAM_SEND_TIMEOUT_MS,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Telegram sendMessage timed out/failed: ${message}`);
    throw err;
  }
  if (!res.ok) {
    const body = await res.text();
    console.error(`Telegram sendMessage failed [${res.status}]: ${body}`);
  }
  return res;
}

function fmtUsd(n: number | null): string {
  if (n == null) return "n/a";
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(4)}`;
}

function fmtPct(n: number | null): string {
  if (n == null) return "n/a";
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(2)}%`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatReport(
  info: TokenInfo,
  sticky: AnalysisResult,
  whale: WhalePressureResult,
): string {
  const nameLine = info.name
    ? `<b>${esc(info.name)}</b>${info.symbol ? ` <i>($${esc(info.symbol)})</i>` : ""}`
    : `<b>Unknown token</b>`;

  const lines: string[] = [];
  lines.push(nameLine);
  lines.push(`<code>${esc(info.mint)}</code>`);
  lines.push(`🔗 <a href="${info.dexscreenerUrl}">DexScreener</a>`);
  lines.push("");
  lines.push(`💵 Price: ${fmtUsd(info.priceUsd)}  (${fmtPct(info.priceChange24h)} 24h)`);
  lines.push(`📊 MCap: ${fmtUsd(info.marketCapUsd)}   💧 Liq: ${fmtUsd(info.liquidityUsd)}`);
  lines.push(`🔄 24h Vol: ${fmtUsd(info.volume24hUsd)}`);
  lines.push("");

  // Sticky buyers
  lines.push(`━━━ 🎯 <b>Sticky Buyers</b> ━━━`);
  lines.push(`Grade: <b>${sticky.grade}</b> (${sticky.gradeScore}/100)`);
  lines.push(`<i>${esc(sticky.gradeReason)}</i>`);
  lines.push(`Scanned ${sticky.scannedTransactions} swaps · excluded ${sticky.excludedLpLike} LP-like`);
  for (const b of ["1d", "2d", "7d"] as const) {
    const bk = sticky.buckets[b];
    lines.push(
      `• <b>${b}</b>: ${bk.stillHolding}/${bk.qualifyingBuyers} buyers still hold $100+`,
    );
  }
  if (!sticky.reachedWindowEnd) {
    lines.push(`<i>⚠️ Hit pagination cap; older 7d buyers may be missing.</i>`);
  }
  lines.push("");

  // Whale pressure
  lines.push(`━━━ 🐳 <b>Whale Pressure</b> ━━━`);
  lines.push(
    `Scanned ${whale.scannedWallets} top wallets` +
      (whale.skippedExchange > 0 ? ` (skipped ${whale.skippedExchange} CEX)` : ""),
  );
  for (const w of ["1d", "2d", "7d"] as WhaleBucket[]) {
    const win = whale.windows[w];
    const sign = win.aggregateScore >= 0 ? "+" : "";
    lines.push(
      `• <b>${w}</b>: <b>${sign}${win.aggregateScore.toFixed(1)}</b> ${win.label}`,
    );
    lines.push(
      `    🟢${win.buying}  🔴${win.selling}  ⚪${win.neutral}`,
    );
  }

  // Top 5 wallets by 7d net
  const top7d = [...whale.wallets]
    .sort((a, b) => Math.abs(b.perWindow["7d"].net) - Math.abs(a.perWindow["7d"].net))
    .slice(0, 5);
  if (top7d.length > 0) {
    lines.push("");
    lines.push(`<b>Top movers (7d net tokens):</b>`);
    for (const w of top7d) {
      const net = w.perWindow["7d"].net;
      const arrow = net >= 0 ? "🟢" : "🔴";
      const short = `${w.address.slice(0, 4)}…${w.address.slice(-4)}`;
      lines.push(
        `${arrow} <a href="https://solscan.io/account/${w.address}">${short}</a> · ${w.pctSupply.toFixed(2)}% supply · net ${net >= 0 ? "+" : ""}${net.toLocaleString()}`,
      );
    }
  }

  return lines.join("\n");
}

export function formatError(message: string): string {
  return `❌ <b>Scan failed</b>\n${esc(message)}`;
}

export function formatHelp(): string {
  return [
    "👋 <b>Solana Token Scanner</b>",
    "",
    "Send me a Solana token mint address and I'll reply with:",
    "• Token info + DexScreener link",
    "• Sticky-buyer report (who bought $100+ and still holds)",
    "• Whale-pressure report (top holders' buy/sell conviction)",
    "",
    "Example: <code>DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263</code>",
    "",
    "<i>Scans take 30–90 seconds.</i>",
  ].join("\n");
}
