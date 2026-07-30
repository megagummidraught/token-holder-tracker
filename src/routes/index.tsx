import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { analyzeToken, type AnalysisResult } from "@/lib/token-analysis.functions";
import {
  analyzeWhalePressure,
  type WhalePressureResult,
} from "@/lib/whale-pressure.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Solana Token Sticky Buyers" },
      {
        name: "description",
        content:
          "Analyze how many buyers of a Solana token spent over $100 in the last 1d/2d/7d and still hold over $100 today.",
      },
      { property: "og:title", content: "Solana Token Sticky Buyers" },
      {
        property: "og:description",
        content:
          "Analyze how many buyers of a Solana token spent over $100 in the last 1d/2d/7d and still hold over $100 today.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

function shortAddr(a: string) {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function fmtUsd(n: number) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function gradeColor(g: string) {
  if (g === "A+" || g === "A") return "bg-emerald-500/20 text-emerald-500";
  if (g === "B") return "bg-lime-500/20 text-lime-500";
  if (g === "C") return "bg-yellow-500/20 text-yellow-500";
  if (g === "D") return "bg-orange-500/20 text-orange-500";
  return "bg-destructive/20 text-destructive";
}

interface ScannerAlert {
  id: string;
  mint: string;
  symbol: string | null;
  name: string | null;
  grade: string;
  score: number;
  liquidity_usd: number | null;
  volume_24h_usd: number | null;
  created_at: string;
}

function RecentAlerts() {
  const { data } = useQuery({
    queryKey: ["scanner-alerts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("scanner_alerts")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as ScannerAlert[];
    },
    refetchInterval: 60_000,
  });

  return (
    <section className="mt-10 rounded-lg border border-border p-4">
      <h2 className="text-lg font-semibold">Auto-scanner alerts</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Top-volume Solana tokens are scanned every 15 minutes; an A or A+ sticky-buyer
        grade fires a Telegram alert. Send <code>/alerts_on</code> to the bot to subscribe.
      </p>
      {!data?.length ? (
        <p className="mt-4 text-sm text-muted-foreground">No alerts yet.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {data.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <a
                  className="font-medium text-primary hover:underline"
                  href={`https://dexscreener.com/solana/${a.mint}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {a.symbol ? `$${a.symbol}` : shortAddr(a.mint)}
                </a>
                <span className="ml-2 text-xs text-muted-foreground">
                  {new Date(a.created_at).toLocaleString()}
                </span>
              </div>
              <span
                className={`rounded px-2 py-0.5 text-xs font-semibold ${gradeColor(a.grade)}`}
              >
                {a.grade} · {a.score}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


function Index() {
  const [mint, setMint] = useState("");
  const analyze = useServerFn(analyzeToken);
  const whaleFn = useServerFn(analyzeWhalePressure);
  const mutation = useMutation({
    mutationFn: (m: string) => analyze({ data: { mint: m } }),
  });
  const whaleMutation = useMutation({
    mutationFn: (m: string) => whaleFn({ data: { mint: m, topN: 20 } }),
  });

  const result = mutation.data as AnalysisResult | undefined;
  const whale = whaleMutation.data as WhalePressureResult | undefined;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">
            Solana Sticky Buyer Scanner
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            For a token mint, counts buyers who spent &gt; $100 in the window and
            still hold &gt; $100 today. Powered by Helius + Jupiter.
          </p>
          <p className="mt-3 text-sm">
            📱 Also on Telegram:{" "}
            <a
              className="font-medium text-primary hover:underline"
              href="https://t.me/AlphaCarrd_bot"
              target="_blank"
              rel="noreferrer"
            >
              @AlphaCarrd_bot
            </a>{" "}
            — DM a mint and get the full report (token info + DexScreener +
            sticky buyers + whale pressure).
          </p>
        </header>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = mint.trim();
            if (v) {
              mutation.mutate(v);
              whaleMutation.mutate(v);
            }
          }}
        >
          <input
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder="Solana token mint address"
            value={mint}
            onChange={(e) => setMint(e.target.value)}
          />
          <button
            type="submit"
            disabled={mutation.isPending || !mint.trim()}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {mutation.isPending ? "Scanning…" : "Analyze"}
          </button>
        </form>

        {mutation.isPending && (
          <p className="mt-6 text-sm text-muted-foreground">
            Fetching swap history (this can take 30–90s for busy tokens)…
          </p>
        )}

        {mutation.isError && (
          <div className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {(mutation.error as Error).message}
          </div>
        )}

        {result && (
          <div className="mt-8 space-y-6">
            <div className="rounded-md border border-border bg-card p-4 text-card-foreground">
              <div className="flex items-center gap-4">
                <div className={`flex h-16 w-16 items-center justify-center rounded-md text-2xl font-bold ${gradeColor(result.grade)}`}>
                  {result.grade}
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium">Sticky-buyer score: {result.gradeScore}/100</div>
                  <div className="text-xs text-muted-foreground">{result.gradeReason}</div>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <Info label="Token price" value={`$${result.tokenPriceUsd.toPrecision(4)}`} />
                <Info label="SOL price" value={fmtUsd(result.solPriceUsd)} />
                <Info label="Swaps scanned" value={result.scannedTransactions.toString()} />
                <Info label="LP-like excluded" value={result.excludedLpLike.toString()} />
              </div>
              {!result.reachedWindowEnd && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Scan hit the pagination cap; results reflect the most recent
                  swaps only. Older buyers in the 7d bucket may be missing.
                </p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              {(["1d", "2d", "7d"] as const).map((b) => (
                <div
                  key={b}
                  className="rounded-md border border-border bg-card p-4 text-card-foreground"
                >
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Last {b}
                  </div>
                  <div className="mt-2 text-3xl font-bold">
                    {result.buckets[b].stillHolding}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    still hold &gt; $100
                  </div>
                  <div className="mt-3 text-sm">
                    {result.buckets[b].qualifyingBuyers} buyers spent &gt; $100
                  </div>
                </div>
              ))}
            </div>

            {(["1d", "2d", "7d"] as const).map((b) => (
              <BucketTable key={b} label={`Last ${b}`} bucket={result.buckets[b]} />
            ))}
          </div>
        )}

        {whaleMutation.isPending && (
          <p className="mt-6 text-sm text-muted-foreground">
            Scanning top-20 holder wallets for whale pressure…
          </p>
        )}

        {whaleMutation.isError && (
          <div className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            Whale pressure: {(whaleMutation.error as Error).message}
          </div>
        )}

        {whale && <WhaleSection whale={whale} />}
      </div>
    </div>
  );
}

function WhaleSection({ whale }: { whale: WhalePressureResult }) {
  const top = [...whale.wallets]
    .sort(
      (a, b) => Math.abs(b.perWindow["7d"].net) - Math.abs(a.perWindow["7d"].net),
    )
    .slice(0, 10);
  return (
    <div className="mt-8 space-y-4">
      <div className="rounded-md border border-border bg-card p-4 text-card-foreground">
        <div className="text-sm font-semibold">🐳 Whale Pressure</div>
        <div className="mt-1 text-xs text-muted-foreground">
          Scanned {whale.scannedWallets} top wallets
          {whale.skippedExchange > 0
            ? ` (skipped ${whale.skippedExchange} CEX)`
            : ""}
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {(["1d", "2d", "7d"] as const).map((w) => {
            const win = whale.windows[w];
            return (
              <div key={w} className="rounded-md border border-border p-3">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Last {w}
                </div>
                <div className="mt-1 text-2xl font-bold">
                  {win.aggregateScore >= 0 ? "+" : ""}
                  {win.aggregateScore.toFixed(1)}
                </div>
                <div className="mt-1 text-xs">{win.label}</div>
                <div className="mt-2 text-xs text-muted-foreground">
                  🟢 {win.buying} · 🔴 {win.selling} · ⚪ {win.neutral}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {top.length > 0 && (
        <div className="rounded-md border border-border bg-card">
          <div className="border-b border-border px-4 py-2 text-sm font-semibold">
            Top movers (7d net tokens)
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Wallet</th>
                  <th className="px-4 py-2 font-medium">% supply</th>
                  <th className="px-4 py-2 font-medium">7d net</th>
                  <th className="px-4 py-2 font-medium">7d score</th>
                </tr>
              </thead>
              <tbody>
                {top.map((w) => {
                  const pw = w.perWindow["7d"];
                  return (
                    <tr key={w.address} className="border-t border-border">
                      <td className="px-4 py-2 font-mono">
                        <a
                          href={`https://solscan.io/account/${w.address}`}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                        >
                          {shortAddr(w.address)}
                        </a>
                      </td>
                      <td className="px-4 py-2">{w.pctSupply.toFixed(2)}%</td>
                      <td
                        className={
                          pw.net >= 0
                            ? "px-4 py-2 text-emerald-500"
                            : "px-4 py-2 text-destructive"
                        }
                      >
                        {pw.net >= 0 ? "+" : ""}
                        {pw.net.toLocaleString()}
                      </td>
                      <td className="px-4 py-2">{pw.score.toFixed(1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

function BucketTable({
  label,
  bucket,
}: {
  label: string;
  bucket: AnalysisResult["buckets"]["1d"];
}) {
  if (bucket.buyers.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-card">
      <div className="border-b border-border px-4 py-2 text-sm font-semibold">
        {label} — top buyers (showing {bucket.buyers.length} of{" "}
        {bucket.qualifyingBuyers})
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Wallet</th>
              <th className="px-4 py-2 font-medium">Bought (USD)</th>
              <th className="px-4 py-2 font-medium">Current holding (USD)</th>
              <th className="px-4 py-2 font-medium">Still holds &gt; $100</th>
            </tr>
          </thead>
          <tbody>
            {bucket.buyers.map((b) => (
              <tr key={b.address} className="border-t border-border">
                <td className="px-4 py-2 font-mono">
                  <a
                    href={`https://solscan.io/account/${b.address}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline"
                  >
                    {shortAddr(b.address)}
                  </a>
                </td>
                <td className="px-4 py-2">{fmtUsd(b.usdBought)}</td>
                <td className="px-4 py-2">{fmtUsd(b.currentUsd)}</td>
                <td className="px-4 py-2">
                  {b.currentUsd >= 100 ? "✅" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
