import { type Address, type Hex } from "viem";
import { z, type ZodType } from "zod";
import { formatAmount } from "@vendor/dg-vendor-math";
import type { RunnerConfig } from "../config";
import type { AgentWallet } from "../wallet";

export const ASSETS = ["ETH", "USDC", "UP", "DG"] as const;
export const assetSchema = z.enum(ASSETS);
export type Asset = z.infer<typeof assetSchema>;

export const assetAmountSchema = z
  .object({
    asset: assetSchema,
    tokenAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .nullable(),
    decimals: z.number().int().min(0).max(255),
    raw: z.string().regex(/^\d+$/),
    formatted: z.string(),
  })
  .strict();
export type AssetAmount = z.infer<typeof assetAmountSchema>;

export const actionEconomicsSchema = z
  .object({
    gas: z
      .object({
        estimateRaw: z.string().regex(/^\d+$/).nullable(),
        priceRaw: z.string().regex(/^\d+$/).nullable(),
        costRaw: z.string().regex(/^\d+$/).nullable(),
        costUsd: z.string().nullable(),
        method: z.enum(["measured", "unavailable"]),
        scope: z.literal("primary_transaction"),
      })
      .strict(),
    value: z
      .object({
        principal: assetAmountSchema.nullable(),
        expectedOutput: assetAmountSchema.nullable(),
        minimumOutput: assetAmountSchema.nullable(),
        feeBps: z.number().int().min(0).max(10_000).nullable(),
      })
      .strict(),
    api: z
      .object({ routeId: z.string().min(1), priceUsd: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
export type ActionEconomics = z.infer<typeof actionEconomicsSchema>;

const unavailableActionEconomics: ActionEconomics = {
  gas: {
    estimateRaw: null,
    priceRaw: null,
    costRaw: null,
    costUsd: null,
    method: "unavailable",
    scope: "primary_transaction",
  },
  value: {
    principal: null,
    expectedOutput: null,
    minimumOutput: null,
    feeBps: null,
  },
  api: null,
};

// Truncated display precision prevents UI and model callers from overstating amounts.
export function displayAmount(raw: bigint, decimals: number): string {
  return formatAmount(raw, decimals, decimals >= 18 ? 6 : 2);
}

export function assetAmount(
  asset: Asset,
  raw: bigint,
  decimals: number,
  tokenAddress: Address | null,
): AssetAmount {
  return assetAmountSchema.parse({
    asset,
    tokenAddress,
    decimals,
    raw: raw.toString(),
    formatted: displayAmount(raw, decimals),
  });
}

/**
 * `deficitRaw` is the single field the planner reads to decide whether a
 * shortfall needs resolving. It lives here rather than on the AssetAmount
 * beside it because points and fuel are shortfalls too, and an AssetAmount
 * cannot express them — which is why they were silently unresolvable.
 */
const requirementValueSchema = {
  requiredRaw: z.string().regex(/^\d+$/),
  deficitRaw: z.string().regex(/^\d+$/),
};

export const requirementReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("asset"),
      asset: assetSchema,
      ...requirementValueSchema,
    })
    .strict(),
  z.object({ kind: z.literal("points"), ...requirementValueSchema }).strict(),
  z.object({ kind: z.literal("fuel"), ...requirementValueSchema }).strict(),
  z.object({ kind: z.literal("stage"), ...requirementValueSchema }).strict(),
]);
export type RequirementReference = z.infer<typeof requirementReferenceSchema>;

export const actionPurposeSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("quest_task"), taskId: z.string().min(1) })
    .strict(),
  z
    .object({
      kind: z.literal("prerequisite"),
      forTaskId: z.string().min(1),
      resolves: z.array(requirementReferenceSchema).min(1),
    })
    .strict(),
]);
export type ActionPurpose = z.infer<typeof actionPurposeSchema>;

export const blockerSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    resolution: z.enum(["agent", "owner", "time", "fatal"]),
  })
  .strict();
export type Blocker = z.infer<typeof blockerSchema>;

export const actionAnalysisSchema = z
  .object({
    executableNow: z.boolean(),
    requirements: z.array(
      z
        .object({
          reference: requirementReferenceSchema,
          // Formatted for the model to read; the shortfall the planner acts on
          // is `reference.deficitRaw`.
          required: assetAmountSchema.optional(),
          available: assetAmountSchema.optional(),
          deficit: assetAmountSchema.optional(),
        })
        .strict(),
    ),
    effects: z.array(
      z
        .object({
          kind: z.enum(["asset", "points", "fuel", "stage"]),
          asset: assetAmountSchema.optional(),
          estimatedChangeRaw: z.string().regex(/^-?\d+$/),
        })
        .strict(),
    ),
    blockers: z.array(blockerSchema),
    gasEstimateRaw: z.string().regex(/^\d+$/).nullable(),
    economics: actionEconomicsSchema.default(unavailableActionEconomics),
    quote: z
      .object({
        source: z.enum(["rpc", "contract", "task_config", "none"]),
        blockNumber: z.string().regex(/^\d+$/).nullable(),
        observedAt: z.string().datetime(),
        expiresAt: z.string().datetime().nullable(),
      })
      .strict(),
  })
  .strict();
export type ActionAnalysis = z.infer<typeof actionAnalysisSchema>;

export function actionValue(
  principal: AssetAmount | null = null,
  expectedOutput: AssetAmount | null = null,
  minimumOutput: AssetAmount | null = null,
  feeBps: number | null = null,
): ActionEconomics["value"] {
  return { principal, expectedOutput, minimumOutput, feeBps };
}

export function actionEconomics(
  gas: ActionEconomics["gas"],
  value: ActionEconomics["value"] = actionValue(),
): ActionEconomics {
  return { gas, value, api: null };
}

export function zeroGasEconomics(): ActionEconomics["gas"] {
  return {
    estimateRaw: "0",
    priceRaw: "0",
    costRaw: "0",
    costUsd: "0",
    method: "measured",
    scope: "primary_transaction",
  };
}

export async function estimateActionGas(
  wallet: ReadOnlyAgentWallet,
  transaction: { to: Address; data: Hex; value?: bigint },
): Promise<ActionEconomics["gas"]> {
  const [estimate, price] = await Promise.all([
    Promise.resolve()
      .then(() =>
        wallet.publicClient.estimateGas({
          account: wallet.address,
          to: transaction.to,
          data: transaction.data,
          value: transaction.value ?? 0n,
        }),
      )
      .catch(() => null),
    Promise.resolve()
      .then(() => wallet.publicClient.getGasPrice())
      .catch(() => null),
  ]);
  return {
    estimateRaw: estimate?.toString() ?? null,
    priceRaw: price?.toString() ?? null,
    costRaw:
      estimate !== null && price !== null
        ? (estimate * price).toString()
        : null,
    costUsd: null,
    method: estimate !== null && price !== null ? "measured" : "unavailable",
    scope: "primary_transaction",
  };
}

// Typed as `Hex` rather than `string` so a parsed result is directly usable by
// viem without a cast, and so no separate compat type has to restate it.
const txHashSchema = z.custom<Hex>(
  (value) => typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value),
  { message: "Expected a 32-byte transaction hash" },
);
const approvalSchema = z
  .object({ step: z.string().min(1), txHash: txHashSchema })
  .strict();

export const actionResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("confirmed"),
      txHash: txHashSchema.nullable(),
      approvals: z.array(approvalSchema),
      blockNumber: z.string().regex(/^\d+$/).nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("submitted"),
      txHash: txHashSchema,
      approvals: z.array(approvalSchema),
    })
    .strict(),
  z
    .object({
      status: z.literal("retryable_error"),
      code: z.string().min(1),
      message: z.string().min(1),
      retryClass: z.enum(["network", "rate_limit", "rpc", "llm", "contention"]),
      retryAfterMs: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      status: z.literal("state_changed"),
      code: z.string().min(1),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("owner_required"),
      code: z.string().min(1),
      message: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("fatal_error"),
      code: z.string().min(1),
      message: z.string().min(1),
    })
    .strict(),
]);
export type ActionResult = z.infer<typeof actionResultSchema>;

/** Only a confirmed or submitted result has a hash; every other branch has none. */
export function resultTxHash(result: ActionResult): Hex | null {
  if (result.status === "confirmed") return result.txHash;
  if (result.status === "submitted") return result.txHash;
  return null;
}

/** Approvals ride along with the two branches that broadcast. */
export function resultApprovals(
  result: ActionResult,
): Array<{ step: string; txHash: Hex }> {
  if (result.status === "confirmed" || result.status === "submitted") {
    return result.approvals;
  }
  return [];
}

export interface LegacyActionResult {
  txHash: Hex | null;
  approvals?: Array<{ step: string; txHash: Hex }>;
}

export type ParsedInput<T> =
  | { ok: true; input: T }
  | { ok: false; reason: string };

export interface PreflightDecision {
  execute: boolean;
  code?: string;
  reason?: string;
  note?: string;
}

export interface AgentAction<TInput = unknown> {
  name: string;
  description: string;
  taskTypes: readonly string[];
  parse(taskConfig: unknown): ParsedInput<TInput>;
  preflight?(
    context: Omit<ActionContext, "purpose" | "stateVersion">,
    input: TInput,
  ): Promise<PreflightDecision>;
  execute(
    context: Omit<ActionContext, "purpose" | "stateVersion">,
    input: TInput,
  ): Promise<LegacyActionResult>;
}

export const actionCandidateSchema = z
  .object({
    candidateId: z.string().regex(/^cand_[a-f0-9]{32}$/),
    actionName: z.string().min(1),
    actionVersion: z.number().int().positive(),
    purpose: actionPurposeSchema,
    input: z.record(z.unknown()),
    analysis: actionAnalysisSchema,
    stateVersion: z.string().min(1),
    estimatedCostUsd: z.string().nullable(),
    usefulEffects: z.number().int().nonnegative(),
    rank: z.number().int().positive(),
    explanation: z.string().min(1).max(1000),
    expiresAt: z.string().datetime().nullable(),
  })
  .strict();
export type ActionCandidate = z.infer<typeof actionCandidateSchema>;

export interface ActionContext {
  wallet: AgentWallet;
  config: RunnerConfig;
  purpose: ActionPurpose;
  stateVersion: string;
  onApprovalTransaction?(approval: {
    step: string;
    txHash?: Hex;
  }): Promise<void>;
  onTransactionPrepared?(preparation: {
    approvals: Array<{ step: string; txHash: Hex }>;
  }): Promise<void>;
  onTransactionSubmitted?(submission: {
    txHash: Hex;
    approvals: Array<{ step: string; txHash: Hex }>;
  }): Promise<void>;
}

export type ReadOnlyAgentWallet = Pick<
  AgentWallet,
  "address" | "publicClient" | "caip2"
>;

export interface AnalyzeContext {
  wallet: ReadOnlyAgentWallet;
  config: RunnerConfig;
  purpose: ActionPurpose;
  stateVersion: string;
}

export interface ActionDefinition<
  TInput,
  TAnalysis extends ActionAnalysis = ActionAnalysis,
> {
  name: string;
  version: number;
  description: string;
  taskTypes: readonly string[];
  inputSchema: ZodType<TInput>;
  analysisSchema: ZodType<TAnalysis, z.ZodTypeDef, unknown>;
  resultSchema: ZodType<ActionResult>;
  parseTaskConfig(taskConfig: unknown): TInput;
  supportsNetwork(chainId: number): boolean;
  analyze(context: AnalyzeContext, input: TInput): Promise<TAnalysis>;
  execute(context: ActionContext, input: TInput): Promise<ActionResult>;
}

export interface BoundAction {
  name: string;
  version: number;
  description: string;
  taskTypes: readonly string[];
  inputSchema?: ZodType<unknown>;
  analysisSchema?: ZodType<ActionAnalysis, z.ZodTypeDef, unknown>;
  resultSchema?: ZodType<ActionResult>;
  parse(taskConfig: unknown): ParsedInput<unknown>;
  parseTaskConfig(taskConfig: unknown): unknown;
  supportsNetwork(chainId: number): boolean;
  analyze?(context: AnalyzeContext, input: unknown): Promise<ActionAnalysis>;
  preflight?(
    context: Omit<ActionContext, "purpose" | "stateVersion">,
    input: unknown,
  ): Promise<PreflightDecision>;
  execute(
    context: ActionContext | Omit<ActionContext, "purpose" | "stateVersion">,
    input: unknown,
  ): Promise<ActionResult | LegacyActionResult>;
}

export function bindAction<TInput>(
  action: ActionDefinition<TInput> | AgentAction<TInput>,
): BoundAction {
  if ("parseTaskConfig" in action) {
    return {
      ...action,
      parse(taskConfig: unknown) {
        try {
          return { ok: true, input: action.parseTaskConfig(taskConfig) };
        } catch (error) {
          return {
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      },
    } as unknown as BoundAction;
  }
  return {
    ...action,
    version: 1,
    parseTaskConfig(taskConfig) {
      const result = action.parse(taskConfig);
      if (!result.ok) throw new Error(result.reason);
      return result.input;
    },
    supportsNetwork: (chainId: number) => chainId === 8453,
  } as BoundAction;
}

export function confirmedResult(
  txHash: Hex | null,
  approvals: Array<{ step: string; txHash: Hex }> = [],
  blockNumber: bigint | null = null,
): ActionResult {
  return actionResultSchema.parse({
    status: "confirmed",
    txHash,
    approvals,
    blockNumber: blockNumber?.toString() ?? null,
  });
}

export function observedQuote(
  source: ActionAnalysis["quote"]["source"],
  blockNumber: bigint | null,
  expiresAt: Date | null = null,
): ActionAnalysis["quote"] {
  return {
    source,
    blockNumber: blockNumber?.toString() ?? null,
    observedAt: new Date().toISOString(),
    expiresAt: expiresAt?.toISOString() ?? null,
  };
}

export class UnsupportedActionError extends Error {}
