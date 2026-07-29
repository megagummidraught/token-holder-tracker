## Plan

1. **Stop long Telegram webhook requests from hanging**
   - Change the webhook so it quickly acknowledges Telegram after receiving a valid mint, instead of holding the Telegram request open while the full scan runs.
   - Keep sending the immediate “Scanning…” message to the chat.

2. **Run the report scan with strict time limits**
   - Add timeout protection around the sticky-buyer scan, whale-pressure scan, token metadata lookup, and Telegram sends.
   - If any scan exceeds the limit or a provider call stalls, send a clear failure message back to Telegram instead of leaving the user stuck on “Scanning…”.

3. **Reduce worst-case whale scan duration**
   - Cap per-wallet transaction work more aggressively for the Telegram path while keeping the existing top-20 report shape.
   - Preserve the web UI behavior unless the same timeout guard is needed there too.

4. **Improve server logs for the bot flow**
   - Log scan start, mint, completion, timeout, and provider failures so future Telegram issues can be diagnosed from runtime logs.

5. **Verify**
   - Invoke the Telegram webhook endpoint with a test update shape where possible.
   - Check preview server logs confirm the webhook returns promptly and either completes the report or sends a bounded error instead of repeated long-running requests.

## Technical notes

- Current preview logs show repeated `/api/public/telegram/webhook` requests returning status `0`, which indicates the webhook is not completing cleanly after the bot sends “Scanning…”.
- The fix should focus on `src/routes/api/public/telegram/webhook.ts` and may require small helper changes in the scan/Telegram modules for timeouts and scan limits.