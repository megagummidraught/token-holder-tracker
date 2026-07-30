import { createFileRoute } from "@tanstack/react-router";

async function handle(request: Request) {
  const expected = process.env.SUPABASE_PUBLISHABLE_KEY;
  const provided =
    request.headers.get("apikey") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  if (!expected || provided !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { runScannerPass } = await import("@/lib/scanner.server");
  try {
    const result = await runScannerPass();
    console.log(
      `[scanner] candidates=${result.candidates} scanned=${result.scanned.length} alerted=${result.alerted.length} errors=${result.errors.length}`,
    );
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scanner] run failed: ${message}`);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/scanner/run")({
  server: {
    handlers: {
      POST: async ({ request }) => handle(request),
      GET: async ({ request }) => handle(request),
    },
  },
});
