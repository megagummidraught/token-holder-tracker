import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";

// The webhook handler is intentionally lightweight: it ACKs Telegram quickly,
// then kicks off the scan in the background using the CF Workers waitUntil
// via the request's exposed `event` (TanStack forwards CF ctx via env).
// To keep things portable we just await inline but cap scan sizes; Telegram
// allows up to 60s for webhook processing before retrying.

const MINT_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

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

async function handleUpdate(update: TelegramUpdate): Promise<void> {
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

  await tgSend(chatId, `🔍 Scanning <code>${mint}</code>…\nThis takes 30–90 seconds.`);

  try {
    const [{ getTokenInfoImpl }, { analyzeTokenImpl }, { analyzeWhalePressureImpl }] = await Promise.all([
      import("@/lib/token-info.functions"),
      import("@/lib/token-analysis.functions"),
      import("@/lib/whale-pressure.functions"),
    ]);

    const [info, sticky, whale] = await Promise.all([
      getTokenInfoImpl(mint),
      analyzeTokenImpl(mint),
      analyzeWhalePressureImpl(mint, 20),
    ]);

    await tgSend(chatId, formatReport(info, sticky, whale));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Scan failed:", message);
    await tgSend(chatId, formatError(message));
  }
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
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
        // Process inline. Telegram allows ~60s; scans are tuned to fit.
        await handleUpdate(update);
        return Response.json({ ok: true });
      },
    },
  },
});
