import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { analyzeTokenImpl } from "./token-analysis.server";
import type { AnalysisResult, Grade } from "./token-analysis.server";

export type { AnalysisOptions, AnalysisResult, Grade } from "./token-analysis.server";

export const analyzeToken = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ mint: z.string().trim().min(32).max(64) }).parse(input))
  .handler(async ({ data }): Promise<AnalysisResult> => analyzeTokenImpl(data.mint));

