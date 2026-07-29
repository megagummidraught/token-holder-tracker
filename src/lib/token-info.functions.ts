import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getTokenInfoImpl } from "./token-info.server";
import type { TokenInfo } from "./token-info.server";

export type { TokenInfo } from "./token-info.server";

export const getTokenInfo = createServerFn({ method: "POST" })
  .inputValidator((input) => z.object({ mint: z.string().trim().min(32).max(64) }).parse(input))
  .handler(async ({ data }): Promise<TokenInfo> => getTokenInfoImpl(data.mint));
