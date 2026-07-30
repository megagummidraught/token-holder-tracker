CREATE TABLE public.scanner_subscribers (
  chat_id BIGINT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.scanner_subscribers TO service_role;
ALTER TABLE public.scanner_subscribers ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.scanner_tokens (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  last_grade TEXT,
  last_score INTEGER,
  last_scanned_at TIMESTAMPTZ,
  last_alerted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.scanner_tokens TO anon, authenticated;
GRANT ALL ON public.scanner_tokens TO service_role;
ALTER TABLE public.scanner_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Scanner tokens are publicly readable" ON public.scanner_tokens FOR SELECT TO anon, authenticated USING (true);
CREATE INDEX idx_scanner_tokens_last_scanned ON public.scanner_tokens (last_scanned_at NULLS FIRST);

CREATE TABLE public.scanner_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mint TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  grade TEXT NOT NULL,
  score INTEGER NOT NULL,
  price_usd DOUBLE PRECISION,
  liquidity_usd DOUBLE PRECISION,
  volume_24h_usd DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.scanner_alerts TO anon, authenticated;
GRANT ALL ON public.scanner_alerts TO service_role;
ALTER TABLE public.scanner_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Scanner alerts are publicly readable" ON public.scanner_alerts FOR SELECT TO anon, authenticated USING (true);
CREATE INDEX idx_scanner_alerts_created_at ON public.scanner_alerts (created_at DESC);