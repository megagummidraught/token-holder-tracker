import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { analyzeWhalePressureImpl } from "./whale-pressure.server";
import type { WhalePressureResult } from "./whale-pressure.server";

export type { WhaleBucket, WhalePressureOptions, WhalePressureResult } from "./whale-pressure.server";

export const analyzeWhalePressure = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({
    mint: z.string().trim().min(32).max(64),
    topN: z.number().int().min(5).max(30).default(20),
  }).parse(input))
  .handler(async ({ data }): Promise<WhalePressureResult> => analyzeWhalePressureImpl(data.mint, data.topN));
