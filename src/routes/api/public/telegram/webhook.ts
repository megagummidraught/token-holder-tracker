import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";

const MINT_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const seenUpdates = new Set<number>();
const REPORT_TIMEOUT_MS = 50_000;
const TOKEN_INFO_TIMEOUT_MS = 10_000;
const STICKY_TIMEOUT_MS = 32_000;
const WHALE_TIMEOUT_MS = 36_000;

interface RouteContext {
  executionCtx?: {
    waitUntil?: (promise: Promise<unknown>) => void;
  };
}

function deriveWebhookSecret(apiKey: string): string {
  return createHash("sha256").update(`telegram-webhook:${apiKey}`).digest("base64url");
}

function safeEq(a: string, b: string): boolean {
  const l = Buffer.from(a);
  const r = Buffer.from(b);
  return l.length === r.length && timingSafeEqual(l, r);
}

interface TelegramUpdate {
  update_id?: number;
  message?: {
    chat?: { id?: number };
    text?: string;
    from?: { id?: number; username?: string };
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function scheduleTask(context: unknown, task: Promise<void>): Promise<void> {
  const routeContext = context as RouteContext | undefined;
  const executionCtx = routeContext?.executionCtx;
  const waitUntil = executionCtx?.waitUntil;
  const guarded = task.catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[telegram] background task failed: ${message}`);
  });
  if (typeof waitUntil === "function") {
    console.log("[telegram] running scan via waitUntil");
    waitUntil.call(executionCtx, guarded);
    return;
  }
  // No background primitive available in this runtime: run inline so the work
  // is not dropped when the response is returned.
  console.log("[telegram] no waitUntil available, running scan inline");
  await guarded;
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const started = Date.now();
  const updateId = update.update_id ?? "unknown";
  const msg = update.message;
  const chatId = msg?.chat?.id;
  const text = (msg?.text ?? "").trim();
  if (!chatId || !text) return;

  // Import lazily so the route module stays light.
  const { tgSend, formatReport, formatError, formatHelp } = await import("@/lib/telegram");

  if (text === "/start" || text === "/help") {
    await tgSend(chatId, formatHelp());
    return;
  }

  const match = text.match(MINT_RE);
  if (!match) {
    await tgSend(chatId, formatHelp());
    return;
  }
  const mint = match[0];

  console.log(`[telegram] scan start update=${updateId} mint=${mint}`);
  await tgSend(chatId, `🔍 Scanning <code>${mint}</code>…\nThis takes 30–90 seconds.`);

  try {
    await withTimeout((async () => {
      const [{ getTokenInfoImpl }, { analyzeTokenImpl }, { analyzeWhalePressureImpl }] = await Promise.all([
        import("@/lib/token-info.server"),
        import("@/lib/token-analysis.server"),
        import("@/lib/whale-pressure.server"),
      ]);

      const [info, sticky, whale] = await Promise.all([
        withTimeout(getTokenInfoImpl(mint), TOKEN_INFO_TIMEOUT_MS, "Token info lookup"),
        withTimeout(
          analyzeTokenImpl(mint, { maxPages: 6, maxHoldersToCheck: 120 }),
          STICKY_TIMEOUT_MS,
          "Sticky-buyer scan",
        ),
        withTimeout(
          analyzeWhalePressureImpl(mint, 20, {
            signatureLimitPerWallet: 18,
            txConcurrency: 4,
            walletConcurrency: 5,
          }),
          WHALE_TIMEOUT_MS,
          "Whale-pressure scan",
        ),
      ]);

      await tgSend(chatId, formatReport(info, sticky, whale));
    })(), REPORT_TIMEOUT_MS, "Full report scan");
    console.log(`[telegram] scan complete update=${updateId} mint=${mint} durationMs=${Date.now() - started}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[telegram] scan failed update=${updateId} mint=${mint}: ${message}`);
    await tgSend(chatId, formatError(message));
  }
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request, context }) => {
        const tgKey = process.env.TELEGRAM_API_KEY;
        if (!tgKey) {
          return new Response("TELEGRAM_API_KEY missing", { status: 500 });
        }
        const expected = deriveWebhookSecret(tgKey);
        const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (!safeEq(provided, expected)) {
          return new Response("Unauthorized", { status: 401 });
        }
        let update: TelegramUpdate;
        try {
          update = (await request.json()) as TelegramUpdate;
        } catch {
          return new Response("Bad JSON", { status: 400 });
        }
        const updateId = update.update_id;
        if (typeof updateId === "number") {
          if (seenUpdates.has(updateId)) {
            console.log(`[telegram] duplicate update ignored update=${updateId}`);
            return Response.json({ ok: true, duplicate: true });
          }
          seenUpdates.add(updateId);
          if (seenUpdates.size > 500) {
            const oldest = seenUpdates.values().next().value;
            if (oldest !== undefined) seenUpdates.delete(oldest);
          }
        }
        console.log(`[telegram] update accepted update=${updateId ?? "unknown"}`);
        await scheduleTask(context, handleUpdate(update));
        return Response.json({ ok: true, accepted: true });
      },
    },
  },
});
