import { z } from "zod";
import { assetAmountSchema } from "./actions/types";

export const runSpendSchema = z
  .object({
    startingSpendable: z.array(assetAmountSchema).max(4),
    gasSpent: assetAmountSchema.refine((amount) => amount.asset === "ETH"),
    principalSpent: z.array(assetAmountSchema).max(4),
    apiSpent: assetAmountSchema.refine((amount) => amount.asset === "USDC"),
    apiSaved: assetAmountSchema
      .refine((amount) => amount.asset === "USDC")
      .optional(),
    fundingSwaps: z.number().int().nonnegative(),
    paidCalls: z.number().int().nonnegative(),
    discountedCalls: z.number().int().nonnegative().default(0),
    guards: z
      .object({
        maxFundingSwaps: z.number().int().min(0).max(32).nullable(),
        fundingSwapsRemaining: z.number().int().nonnegative().nullable(),
        maxSteps: z.number().int().positive(),
        stepsRemaining: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type RunSpend = z.infer<typeof runSpendSchema>;

export function parseRunSpend(value: unknown): RunSpend | null {
  const parsed = runSpendSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
