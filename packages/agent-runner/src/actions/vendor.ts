import { encodeFunctionData } from "viem";
import { z } from "zod";
import { DG_TOKEN_VENDOR_ABI } from "@/lib/blockchain/shared/vendor-abi";
import { UNISWAP_ADDRESSES } from "@/lib/uniswap/constants";
import { estimateBuy, estimateBuyInput, estimateSell } from "@/lib/vendor/math";
import { ensureErc20Allowance } from "../approvals";
import { readBalances } from "../balances";
import {
  actionAnalysisSchema,
  actionEconomics,
  actionResultSchema,
  actionValue,
  assetAmount,
  confirmedResult,
  estimateActionGas,
  observedQuote,
  zeroGasEconomics,
  type ActionContext,
  type AnalyzeContext,
  type ActionDefinition,
  type ActionResult,
  type Blocker,
} from "./types";

const amountInputSchema = z
  .object({ amountRaw: z.string().regex(/^[1-9]\d*$/) })
  .strict();
const stageInputSchema = z
  .object({ targetStage: z.number().int().min(0).max(2).nullable() })
  .strict();
export type VendorAmountInput = z.infer<typeof amountInputSchema>;
export type VendorStageInput = z.infer<typeof stageInputSchema>;

type StageConfig = {
  burnAmount: bigint;
  upgradePointsThreshold: bigint;
  upgradeFuelThreshold: bigint;
  fuelRate: bigint;
  pointsAwarded: bigint;
  qualifyingBuyThreshold: bigint;
};

function vendorAddress(): `0x${string}` {
  const value = process.env.NEXT_PUBLIC_DG_VENDOR_ADDRESS;
  if (!value || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error("NEXT_PUBLIC_DG_VENDOR_ADDRESS is not configured");
  }
  return value as `0x${string}`;
}

async function readVendor(ctx: AnalyzeContext) {
  const address = vendorAddress();
  const [tokens, fees, exchangeRate, user, paused, hasValidKey, blockNumber] =
    await Promise.all([
      ctx.wallet.publicClient.readContract({
        address,
        abi: DG_TOKEN_VENDOR_ABI,
        functionName: "getTokenConfig",
      }),
      ctx.wallet.publicClient.readContract({
        address,
        abi: DG_TOKEN_VENDOR_ABI,
        functionName: "getFeeConfig",
      }),
      ctx.wallet.publicClient.readContract({
        address,
        abi: DG_TOKEN_VENDOR_ABI,
        functionName: "getExchangeRate",
      }),
      ctx.wallet.publicClient.readContract({
        address,
        abi: DG_TOKEN_VENDOR_ABI,
        functionName: "getUserState",
        args: [ctx.wallet.address],
      }),
      ctx.wallet.publicClient.readContract({
        address,
        abi: DG_TOKEN_VENDOR_ABI,
        functionName: "paused",
      }),
      ctx.wallet.publicClient.readContract({
        address,
        abi: DG_TOKEN_VENDOR_ABI,
        functionName: "hasValidKey",
        args: [ctx.wallet.address],
      }),
      ctx.wallet.publicClient.getBlockNumber(),
    ]);
  const tokenConfig = tokens as {
    baseToken: `0x${string}`;
    swapToken: `0x${string}`;
  };
  const feeConfig = fees as { buyFeeBps: bigint; sellFeeBps: bigint };
  const userState = user as {
    stage: number | bigint;
    points: bigint;
    fuel: bigint;
  };
  return {
    address,
    tokenConfig,
    feeConfig,
    exchangeRate: exchangeRate as bigint,
    userState: {
      stage: Number(userState.stage),
      points: BigInt(userState.points),
      fuel: BigInt(userState.fuel),
    },
    paused: Boolean(paused),
    hasValidKey: Boolean(hasValidKey),
    blockNumber,
  };
}

/**
 * UP that must be spent to receive at least `dgAmount` DG.
 *
 * Exported so the planner can size a vendor-buy prerequisite without holding a
 * second copy of the vendor's fee and exchange-rate arithmetic.
 */
export async function upRequiredForDg(
  ctx: AnalyzeContext,
  dgAmount: bigint,
): Promise<bigint | null> {
  const state = await readVendor(ctx);
  return estimateBuyInput(
    dgAmount,
    state.feeConfig.buyFeeBps,
    state.exchangeRate,
  );
}

export async function qualifyingBuyForPoints(
  ctx: AnalyzeContext,
): Promise<bigint | null> {
  const state = await readVendor(ctx);
  const stage = (await ctx.wallet.publicClient.readContract({
    address: state.address,
    abi: DG_TOKEN_VENDOR_ABI,
    functionName: "getStageConfig",
    args: [state.userState.stage],
  })) as StageConfig;
  return stage.pointsAwarded > 0n ? stage.qualifyingBuyThreshold : null;
}

function commonBlockers(state: {
  paused: boolean;
  hasValidKey: boolean;
}): Blocker[] {
  return [
    ...(state.paused
      ? [
          {
            code: "VENDOR_PAUSED",
            message: "The vendor is paused.",
            resolution: "time" as const,
          },
        ]
      : []),
    ...(!state.hasValidKey
      ? [
          {
            code: "AGENT_WALLET_NOT_KEYHOLDER",
            message: "The agent wallet needs a valid vendor access key.",
            resolution: "owner" as const,
          },
        ]
      : []),
  ];
}

function estimateVendorGas(
  ctx: AnalyzeContext,
  address: `0x${string}`,
  functionName: "buyTokens" | "sellTokens" | "lightUp" | "upgradeStage",
  args?: readonly [bigint],
) {
  return estimateActionGas(ctx.wallet, {
    to: address,
    data: encodeFunctionData({
      abi: DG_TOKEN_VENDOR_ABI,
      functionName,
      ...(args ? { args } : {}),
    } as never),
  });
}

async function sendVendor(
  ctx: ActionContext,
  functionName: "buyTokens" | "sellTokens" | "lightUp" | "upgradeStage",
  args: readonly [bigint] | undefined,
  approval: { token: `0x${string}`; amount: bigint } | null,
): Promise<ActionResult> {
  const approvals = approval
    ? await ensureErc20Allowance(
        ctx.wallet,
        approval.token,
        vendorAddress(),
        approval.amount,
        ctx.onApprovalTransaction,
      )
    : [];
  await ctx.wallet.publicClient.simulateContract({
    address: vendorAddress(),
    abi: DG_TOKEN_VENDOR_ABI,
    functionName,
    ...(args ? { args } : {}),
    account: ctx.wallet.address,
  } as never);
  await ctx.onTransactionPrepared?.({ approvals });
  const txHash = await ctx.wallet.sendTransaction({
    to: vendorAddress(),
    data: encodeFunctionData({
      abi: DG_TOKEN_VENDOR_ABI,
      functionName,
      ...(args ? { args } : {}),
    } as never),
  });
  await ctx.onTransactionSubmitted?.({ txHash, approvals });
  const receipt = await ctx.wallet.waitForReceipt(txHash);
  if (receipt.status !== "success") {
    return actionResultSchema.parse({
      status: "state_changed",
      code: "TX_REVERTED",
      message: "The vendor transaction reverted; observe current state again.",
    });
  }
  return confirmedResult(txHash, approvals);
}

function parseAmount(taskConfig: unknown, expectedToken: "base" | "swap") {
  const config = z
    .object({
      required_amount: z.union([z.string(), z.number()]),
      required_token: z.enum(["base", "swap"]).optional(),
    })
    .passthrough()
    .parse(taskConfig);
  if (config.required_token && config.required_token !== expectedToken) {
    throw new Error(`required_token must be ${expectedToken}`);
  }
  return amountInputSchema.parse({ amountRaw: String(config.required_amount) });
}

export const vendorBuyAction: ActionDefinition<VendorAmountInput> = {
  name: "p2e_vendor_buy",
  version: 2,
  description: "Buy DG with the task-configured UP amount.",
  taskTypes: ["vendor_buy"],
  inputSchema: amountInputSchema,
  analysisSchema: actionAnalysisSchema,
  resultSchema: actionResultSchema,
  supportsNetwork: (chainId) => chainId === 8453,
  parseTaskConfig: (config) => parseAmount(config, "base"),
  async analyze(ctx, input) {
    const amount = BigInt(amountInputSchema.parse(input).amountRaw);
    const [state, balances] = await Promise.all([
      readVendor(ctx),
      readBalances(ctx.wallet),
    ]);
    const [stage, gas] = await Promise.all([
      ctx.wallet.publicClient.readContract({
        address: state.address,
        abi: DG_TOKEN_VENDOR_ABI,
        functionName: "getStageConfig",
        args: [state.userState.stage],
      }) as Promise<StageConfig>,
      estimateVendorGas(ctx, state.address, "buyTokens", [amount]),
    ]);
    const deficit = amount > balances.UP ? amount - balances.UP : 0n;
    const estimate = estimateBuy(
      amount,
      state.feeConfig.buyFeeBps,
      state.exchangeRate,
    );
    const blockers = commonBlockers(state);
    if (deficit > 0n)
      blockers.push({
        code: "INSUFFICIENT_UP",
        message: `The wallet needs ${deficit} more raw UP.`,
        resolution: "agent",
      });
    return actionAnalysisSchema.parse({
      executableNow: blockers.length === 0,
      requirements: [
        {
          reference: {
            kind: "asset",
            asset: "UP",
            requiredRaw: amount.toString(),
            deficitRaw: deficit.toString(),
          },
          required: assetAmount("UP", amount, 18, UNISWAP_ADDRESSES.up),
          available: assetAmount("UP", balances.UP, 18, UNISWAP_ADDRESSES.up),
          deficit: assetAmount("UP", deficit, 18, UNISWAP_ADDRESSES.up),
        },
      ],
      effects: [
        {
          kind: "asset",
          asset: assetAmount(
            "DG",
            estimate.outSwap,
            18,
            state.tokenConfig.swapToken,
          ),
          estimatedChangeRaw: estimate.outSwap.toString(),
        },
        ...(amount >= stage.qualifyingBuyThreshold && stage.pointsAwarded > 0n
          ? [
              {
                kind: "points" as const,
                estimatedChangeRaw: stage.pointsAwarded.toString(),
              },
            ]
          : []),
      ],
      blockers,
      gasEstimateRaw: gas.estimateRaw,
      economics: actionEconomics(
        gas,
        actionValue(
          assetAmount("UP", amount, 18, state.tokenConfig.baseToken),
          assetAmount("DG", estimate.outSwap, 18, state.tokenConfig.swapToken),
          null,
          Number(state.feeConfig.buyFeeBps),
        ),
      ),
      quote: observedQuote("contract", state.blockNumber),
    });
  },
  async execute(ctx, input) {
    const amount = BigInt(amountInputSchema.parse(input).amountRaw);
    const state = await readVendor(ctx);
    return sendVendor(ctx, "buyTokens", [amount], {
      token: state.tokenConfig.baseToken,
      amount,
    });
  },
};

export const vendorSellAction: ActionDefinition<VendorAmountInput> = {
  name: "p2e_vendor_sell",
  version: 2,
  description: "Sell the task-configured DG amount for UP.",
  taskTypes: ["vendor_sell"],
  inputSchema: amountInputSchema,
  analysisSchema: actionAnalysisSchema,
  resultSchema: actionResultSchema,
  supportsNetwork: (chainId) => chainId === 8453,
  parseTaskConfig: (config) => parseAmount(config, "swap"),
  async analyze(ctx, input) {
    const amount = BigInt(amountInputSchema.parse(input).amountRaw);
    const [state, balances] = await Promise.all([
      readVendor(ctx),
      readBalances(ctx.wallet),
    ]);
    const deficit = amount > balances.DG ? amount - balances.DG : 0n;
    const estimate = estimateSell(
      amount,
      state.feeConfig.sellFeeBps,
      state.exchangeRate,
    );
    const gas = await estimateVendorGas(ctx, state.address, "sellTokens", [
      amount,
    ]);
    const blockers = commonBlockers(state);
    if (deficit > 0n)
      blockers.push({
        code: "INSUFFICIENT_DG",
        message: `The wallet needs ${deficit} more raw DG.`,
        resolution: "agent",
      });
    return actionAnalysisSchema.parse({
      executableNow: blockers.length === 0,
      requirements: [
        {
          reference: {
            kind: "asset",
            asset: "DG",
            requiredRaw: amount.toString(),
            deficitRaw: deficit.toString(),
          },
          required: assetAmount("DG", amount, 18, state.tokenConfig.swapToken),
          available: assetAmount(
            "DG",
            balances.DG,
            18,
            state.tokenConfig.swapToken,
          ),
          deficit: assetAmount("DG", deficit, 18, state.tokenConfig.swapToken),
        },
      ],
      effects: [
        {
          kind: "asset",
          asset: assetAmount(
            "UP",
            estimate.outBase,
            18,
            state.tokenConfig.baseToken,
          ),
          estimatedChangeRaw: estimate.outBase.toString(),
        },
      ],
      blockers,
      gasEstimateRaw: gas.estimateRaw,
      economics: actionEconomics(
        gas,
        actionValue(
          assetAmount("DG", amount, 18, state.tokenConfig.swapToken),
          assetAmount("UP", estimate.outBase, 18, state.tokenConfig.baseToken),
          null,
          Number(state.feeConfig.sellFeeBps),
        ),
      ),
      quote: observedQuote("contract", state.blockNumber),
    });
  },
  async execute(ctx, input) {
    const amount = BigInt(amountInputSchema.parse(input).amountRaw);
    const state = await readVendor(ctx);
    return sendVendor(ctx, "sellTokens", [amount], {
      token: state.tokenConfig.swapToken,
      amount,
    });
  },
};

export const vendorLightUpAction: ActionDefinition<VendorStageInput> = {
  name: "p2e_vendor_light_up",
  version: 2,
  description: "Light up the wallet at its current vendor stage.",
  taskTypes: ["vendor_light_up"],
  inputSchema: stageInputSchema,
  analysisSchema: actionAnalysisSchema,
  resultSchema: actionResultSchema,
  supportsNetwork: (chainId) => chainId === 8453,
  parseTaskConfig: () => ({ targetStage: null }),
  async analyze(ctx) {
    const [state, balances] = await Promise.all([
      readVendor(ctx),
      readBalances(ctx.wallet),
    ]);
    const [stage, gas] = await Promise.all([
      ctx.wallet.publicClient.readContract({
        address: state.address,
        abi: DG_TOKEN_VENDOR_ABI,
        functionName: "getStageConfig",
        args: [state.userState.stage],
      }) as Promise<{ burnAmount: bigint; fuelRate: bigint }>,
      estimateVendorGas(ctx, state.address, "lightUp"),
    ]);
    const deficit =
      stage.burnAmount > balances.UP ? stage.burnAmount - balances.UP : 0n;
    const blockers = commonBlockers(state);
    if (deficit > 0n)
      blockers.push({
        code: "INSUFFICIENT_UP",
        message: `The wallet needs ${deficit} more raw UP.`,
        resolution: "agent",
      });
    return actionAnalysisSchema.parse({
      executableNow: blockers.length === 0,
      requirements: [
        {
          reference: {
            kind: "asset",
            asset: "UP",
            requiredRaw: stage.burnAmount.toString(),
            deficitRaw: deficit.toString(),
          },
          required: assetAmount(
            "UP",
            stage.burnAmount,
            18,
            state.tokenConfig.baseToken,
          ),
          available: assetAmount(
            "UP",
            balances.UP,
            18,
            state.tokenConfig.baseToken,
          ),
          deficit: assetAmount("UP", deficit, 18, state.tokenConfig.baseToken),
        },
      ],
      effects: [
        { kind: "fuel", estimatedChangeRaw: stage.fuelRate.toString() },
      ],
      blockers,
      gasEstimateRaw: gas.estimateRaw,
      economics: actionEconomics(
        gas,
        actionValue(
          assetAmount("UP", stage.burnAmount, 18, state.tokenConfig.baseToken),
        ),
      ),
      quote: observedQuote("contract", state.blockNumber),
    });
  },
  async execute(ctx) {
    const state = await readVendor(ctx);
    const stage = (await ctx.wallet.publicClient.readContract({
      address: state.address,
      abi: DG_TOKEN_VENDOR_ABI,
      functionName: "getStageConfig",
      args: [state.userState.stage],
    })) as { burnAmount: bigint };
    return sendVendor(ctx, "lightUp", undefined, {
      token: state.tokenConfig.baseToken,
      amount: stage.burnAmount,
    });
  },
};

export const vendorLevelUpAction: ActionDefinition<VendorStageInput> = {
  name: "p2e_vendor_level_up",
  version: 2,
  description:
    "Upgrade the wallet after live points and fuel requirements are met.",
  taskTypes: ["vendor_level_up"],
  inputSchema: stageInputSchema,
  analysisSchema: actionAnalysisSchema,
  resultSchema: actionResultSchema,
  supportsNetwork: (chainId) => chainId === 8453,
  parseTaskConfig(config) {
    const raw = z
      .object({ target_stage: z.union([z.string(), z.number()]).optional() })
      .passthrough()
      .parse(config).target_stage;
    return stageInputSchema.parse({
      targetStage: raw === undefined ? null : Number(raw),
    });
  },
  async analyze(ctx, input) {
    const parsed = stageInputSchema.parse(input);
    const state = await readVendor(ctx);
    if (
      parsed.targetStage !== null &&
      state.userState.stage >= parsed.targetStage
    ) {
      return actionAnalysisSchema.parse({
        executableNow: true,
        requirements: [],
        effects: [{ kind: "stage", estimatedChangeRaw: "0" }],
        blockers: [],
        gasEstimateRaw: "0",
        economics: actionEconomics(zeroGasEconomics()),
        quote: observedQuote("contract", state.blockNumber),
      });
    }
    if (state.userState.stage >= 2) {
      return actionAnalysisSchema.parse({
        executableNow: false,
        requirements: [],
        effects: [],
        blockers: [
          {
            code: "MAX_VENDOR_STAGE_REACHED",
            message: "The wallet is already at the vendor's maximum stage.",
            resolution: "fatal",
          },
        ],
        gasEstimateRaw: "0",
        economics: actionEconomics(zeroGasEconomics()),
        quote: observedQuote("contract", state.blockNumber),
      });
    }
    const stage = (await ctx.wallet.publicClient.readContract({
      address: state.address,
      abi: DG_TOKEN_VENDOR_ABI,
      functionName: "getStageConfig",
      args: [state.userState.stage + 1],
    })) as StageConfig;
    const gas = await estimateVendorGas(ctx, state.address, "upgradeStage");
    const pointsDeficit =
      stage.upgradePointsThreshold > state.userState.points
        ? stage.upgradePointsThreshold - state.userState.points
        : 0n;
    const fuelDeficit =
      stage.upgradeFuelThreshold > state.userState.fuel
        ? stage.upgradeFuelThreshold - state.userState.fuel
        : 0n;
    const blockers = commonBlockers(state);
    if (pointsDeficit > 0n)
      blockers.push({
        code: "INSUFFICIENT_POINTS",
        message: `The wallet needs ${pointsDeficit} more vendor points.`,
        resolution: "agent",
      });
    if (fuelDeficit > 0n)
      blockers.push({
        code: "INSUFFICIENT_FUEL",
        message: `The wallet needs ${fuelDeficit} more vendor fuel.`,
        resolution: "agent",
      });
    return actionAnalysisSchema.parse({
      executableNow: blockers.length === 0,
      requirements: [
        {
          reference: {
            kind: "points",
            requiredRaw: stage.upgradePointsThreshold.toString(),
            deficitRaw: pointsDeficit.toString(),
          },
        },
        {
          reference: {
            kind: "fuel",
            requiredRaw: stage.upgradeFuelThreshold.toString(),
            deficitRaw: fuelDeficit.toString(),
          },
        },
      ],
      effects: [{ kind: "stage", estimatedChangeRaw: "1" }],
      blockers,
      gasEstimateRaw: gas.estimateRaw,
      economics: actionEconomics(gas),
      quote: observedQuote("contract", state.blockNumber),
    });
  },
  async execute(ctx, input) {
    const parsed = stageInputSchema.parse(input);
    const state = await readVendor(ctx);
    if (
      parsed.targetStage !== null &&
      state.userState.stage >= parsed.targetStage
    ) {
      return confirmedResult(null);
    }
    return sendVendor(ctx, "upgradeStage", undefined, null);
  },
};
