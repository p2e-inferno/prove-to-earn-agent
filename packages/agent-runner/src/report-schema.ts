import { z } from "zod";

// Rendered as a link on the owner's page, so anything but https is dropped.
export const attestationUrlSchema = z.string().url().startsWith("https://");

export const questCompletionSchema = z
  .object({
    txHash: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/)
      .nullable(),
    bonusAmount: z.number().finite().nonnegative(),
    rewardWallet: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .nullable(),
  })
  .strict();

export type QuestCompletion = z.infer<typeof questCompletionSchema>;

export const reportTaskSchema = z
  .object({
    title: z.string(),
    status: z.enum([
      "completed",
      "claimed",
      "reward_pending",
      "skipped",
      "failed",
    ]),
    attestationUrl: attestationUrlSchema.optional().catch(undefined),
  })
  .passthrough();

export const reportActionSchema = z
  .object({
    actionName: z.string().min(1),
    purpose: z.enum(["quest_task", "prerequisite"]),
    taskId: z.string(),
    status: z.string().min(1),
  })
  .passthrough();
