import { z } from "zod";

export const rawAmountSchema = z.string().regex(/^(0|[1-9]\d*)$/);
export const caip2Schema = z.string().regex(/^eip155:\d+$/);
export const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
export const bytes32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
export const candidateIdSchema = z.string().regex(/^cand_[a-f0-9]{32}$/);

/** A held/observed balance for one asset, formatted for display alongside
 * its raw integer amount. Mirrors the runner's `AssetAmount` shape so a
 * decision frame can report balances without a dependency on the runner
 * package. */
export const assetAmountRefSchema = z
  .object({
    asset: z.string().min(1).max(32),
    tokenAddress: addressSchema.nullable(),
    decimals: z.number().int().min(0).max(255),
    raw: rawAmountSchema,
    formatted: z.string(),
  })
  .strict();

export const actionIdSchema = z.enum([
  "p2e_uniswap_swap",
  "p2e_vendor_buy",
  "p2e_vendor_sell",
  "p2e_vendor_light_up",
  "p2e_vendor_level_up",
  "p2e_eth_transfer",
  "p2e_erc20_transfer",
  "p2e_deploy_lock",
  "p2e_daily_checkin",
  "p2e_gas_drop",
  "approval.erc20",
  "approval.permit2",
  "x402.payment",
  "quest.claim",
  "quest.settle",
]);

export const authorizedActionSchema = z
  .object({
    actionId: actionIdSchema,
    version: z.number().int().positive(),
  })
  .strict();

const assetLimitSchema = z
  .object({
    asset: z.string().min(1).max(32),
    tokenAddress: addressSchema.nullable(),
    perActionRaw: rawAmountSchema,
    perRunRaw: rawAmountSchema,
    rolling24hRaw: rawAmountSchema,
  })
  .strict();

export const authorizationPolicyV1Schema = z
  .object({
    version: z.literal(1),
    chain: caip2Schema,
    resource: z.string().url().max(2048),
    templateIds: z.array(z.string().uuid()).max(100),
    actions: z.array(authorizedActionSchema).max(64),
    assetLimits: z.array(assetLimitSchema).min(1).max(32),
    maxGasPerActionRaw: rawAmountSchema,
    maxGasPerRunRaw: rawAmountSchema,
    maxGasRolling24hRaw: rawAmountSchema,
    maxX402PerRequestRaw: rawAmountSchema,
    maxX402PerRunRaw: rawAmountSchema,
    maxX402Rolling24hRaw: rawAmountSchema,
    maxServiceFeePerActionRaw: rawAmountSchema,
    maxServiceFeePerRunRaw: rawAmountSchema,
    maxServiceFeeRolling24hRaw: rawAmountSchema,
    minNativeReserveRaw: rawAmountSchema,
    maxFundingSwapsPerRun: z.number().int().min(0).max(32),
    maxSlippageBps: z.number().int().min(0).max(2_000),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const actionIds = new Set<string>();
    policy.actions.forEach((action, index) => {
      if (actionIds.has(action.actionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["actions", index, "actionId"],
          message: "Action policies must be unique",
        });
      }
      actionIds.add(action.actionId);
    });

    const templateIds = new Set<string>();
    policy.templateIds.forEach((templateId, index) => {
      if (templateIds.has(templateId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["templateIds", index],
          message: "Template scopes must be unique",
        });
      }
      templateIds.add(templateId);
    });

    const assets = new Set<string>();
    policy.assetLimits.forEach((limit, index) => {
      const key = `${limit.asset}:${limit.tokenAddress?.toLowerCase() ?? "native"}`;
      if (assets.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assetLimits", index],
          message: "Asset limits must be unique",
        });
      }
      assets.add(key);
      if (
        BigInt(limit.perActionRaw) > BigInt(limit.perRunRaw) ||
        BigInt(limit.perRunRaw) > BigInt(limit.rolling24hRaw)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assetLimits", index],
          message:
            "Asset limits must increase from action to run to rolling window",
        });
      }
    });

    const ordered = (
      action: string,
      run: string,
      rolling: string,
      path: string,
    ) => {
      if (BigInt(action) > BigInt(run) || BigInt(run) > BigInt(rolling)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: "Limits must increase from action to run to rolling window",
        });
      }
    };
    ordered(
      policy.maxGasPerActionRaw,
      policy.maxGasPerRunRaw,
      policy.maxGasRolling24hRaw,
      "maxGasPerActionRaw",
    );
    ordered(
      policy.maxX402PerRequestRaw,
      policy.maxX402PerRunRaw,
      policy.maxX402Rolling24hRaw,
      "maxX402PerRequestRaw",
    );
    ordered(
      policy.maxServiceFeePerActionRaw,
      policy.maxServiceFeePerRunRaw,
      policy.maxServiceFeeRolling24hRaw,
      "maxServiceFeePerActionRaw",
    );
  });

export type AuthorizationPolicyV1 = z.infer<typeof authorizationPolicyV1Schema>;

export const authorizationTypedMessageSchema = z
  .object({
    authorizationId: z.string().uuid(),
    policyVersion: z.literal(1),
    ownerSubjectHash: bytes32Schema,
    agentId: z.string().uuid(),
    agentWallet: addressSchema,
    rewardWallet: addressSchema,
    chainId: z.number().int().positive(),
    resource: z.string().url().max(2048),
    policyHash: bytes32Schema,
    nonce: bytes32Schema,
    issuedAt: z.number().int().positive(),
    /** 0 is the signed sentinel for "no expiry" — a real timestamp is never 0. */
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();

export type AuthorizationTypedMessage = z.infer<
  typeof authorizationTypedMessageSchema
>;

export const decisionConsequenceSchema = z
  .object({
    actionId: actionIdSchema,
    actionVersion: z.number().int().positive(),
    target: addressSchema.nullable(),
    spender: addressSchema.nullable(),
    asset: z.string().min(1).max(32),
    tokenAddress: addressSchema.nullable(),
    maxDebitRaw: rawAmountSchema,
    maxGasRaw: rawAmountSchema,
    maxServiceFeeRaw: rawAmountSchema,
  })
  .strict();

/** Why a candidate is being offered: a quest task itself, or a prerequisite
 * (funding/approval) that unblocks one. Mirrors `ActionPurpose` in the
 * runner so a decision authority can explain a candidate without seeing raw
 * task config. */
export const decisionCandidatePurposeSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("quest_task"), taskId: z.string().min(1) })
    .strict(),
  z
    .object({ kind: z.literal("prerequisite"), forTaskId: z.string().min(1) })
    .strict(),
]);

export const decisionCandidateBlockerSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    resolution: z.enum(["agent", "owner", "time", "fatal"]),
  })
  .strict();

export const decisionCandidateV1Schema = z
  .object({
    candidateId: candidateIdSchema,
    frameId: z.string().uuid(),
    expectedExecutionVersion: z.number().int().nonnegative(),
    /** The candidate-specific observed-state marker (independent of the
     * frame-level `expectedExecutionVersion`) that the worker re-checks
     * before honoring a selection — load-bearing for staleness detection,
     * not display-only. */
    stateVersion: z.string().min(1),
    consequence: decisionConsequenceSchema,
    fingerprint: bytes32Schema,
    expiresAt: z.string().datetime(),
    description: z.string().min(1).max(1000),
    purpose: decisionCandidatePurposeSchema.optional(),
    blockers: z.array(decisionCandidateBlockerSchema).optional(),
  })
  .strict();

export const decisionFrameBlockerSchema = z
  .object({
    taskId: z.string().min(1),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const decisionFrameV1Schema = z
  .object({
    version: z.literal(1),
    frameId: z.string().uuid(),
    commandId: z.string().uuid(),
    executionId: z.string().uuid(),
    expectedExecutionVersion: z.number().int().nonnegative(),
    candidates: z.array(decisionCandidateV1Schema).min(1).max(64),
    expiresAt: z.string().datetime(),
    /** Execution-wallet balances only, as observed when the frame was built. */
    balances: z.array(assetAmountRefSchema).optional(),
    /** Platform-invariant failures — never offered as choices, just context. */
    platformBlockers: z.array(decisionFrameBlockerSchema).optional(),
    /** Owner-policy failures that may annotate an otherwise safe candidate. */
    ownerPolicyBlockers: z
      .array(
        decisionFrameBlockerSchema.extend({
          deficitRaw: z.string().optional(),
        }),
      )
      .optional(),
  })
  .strict();

export const decisionSelectionV1Schema = z
  .object({
    frameId: z.string().uuid(),
    candidateId: candidateIdSchema,
    expectedExecutionVersion: z.number().int().nonnegative(),
  })
  .strict();

export type DecisionFrameV1 = z.infer<typeof decisionFrameV1Schema>;
export type DecisionCandidateV1 = z.infer<typeof decisionCandidateV1Schema>;
export type DecisionSelectionV1 = z.infer<typeof decisionSelectionV1Schema>;

export const admissionSelectionV1Schema = z
  .object({
    expectedCommandVersion: z.number().int().nonnegative(),
    resolution: z.enum(["proceed", "retry", "cancel"]),
  })
  .strict();

export const runResolutionSelectionV1Schema = z
  .object({
    decisionId: z.string().uuid(),
    expectedExecutionVersion: z.number().int().nonnegative(),
    expectedCommandVersion: z.number().int().nonnegative(),
    resolution: z.enum(["retry", "finalize", "cancel"]),
  })
  .strict();

export const headlessDecisionSelectionV1Schema = z.union([
  decisionSelectionV1Schema,
  admissionSelectionV1Schema,
  runResolutionSelectionV1Schema,
]);

export const runStatusV1Schema = z.enum([
  "queued",
  "planning",
  "running",
  "decision_required",
  "waiting_retry",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

export const usageLineV1Schema = z
  .object({
    effectId: z.string().uuid(),
    commandId: z.string().uuid(),
    executionId: z.string().uuid().nullable(),
    actionId: actionIdSchema,
    category: z.enum(["asset", "gas", "x402", "service_fee"]),
    asset: z.string().min(1).max(32),
    tokenAddress: addressSchema.nullable(),
    reservedRaw: rawAmountSchema,
    actualRaw: rawAmountSchema.nullable(),
    state: z.enum([
      "reserved",
      "prepared",
      "submitted",
      "reconciled",
      "released",
    ]),
    createdAt: z.string().datetime(),
  })
  .strict();

export const usageSummaryV1Schema = z
  .object({
    agentId: z.string().uuid(),
    windowStartedAt: z.string().datetime(),
    totals: z.array(
      z
        .object({
          category: usageLineV1Schema.shape.category,
          asset: z.string().min(1).max(32),
          reservedRaw: rawAmountSchema,
          actualRaw: rawAmountSchema,
        })
        .strict(),
    ),
    lines: z.array(usageLineV1Schema),
  })
  .strict();

export type UsageSummaryV1 = z.infer<typeof usageSummaryV1Schema>;

export const agentErrorCodeSchema = z.enum([
  "AUTHORIZATION_REQUIRED",
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_REVOKED",
  "CREDENTIAL_INVALID",
  "CREDENTIAL_REVOKED",
  "PAID_ACCESS_REQUIRED",
  "POLICY_DENIED",
  "BUDGET_EXCEEDED",
  "DECISION_REQUIRED",
  "DECISION_STALE",
  "CANDIDATE_INVALID",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "RUN_BUSY",
  "RATE_LIMITED",
  "TEMPORARILY_UNAVAILABLE",
]);

export const agentEnvelopeV1Schema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: agentErrorCodeSchema.or(z.string().min(1)),
      message: z.string().min(1),
      retryable: z.boolean(),
      details: z.record(z.unknown()).optional(),
    })
    .strict(),
]);
