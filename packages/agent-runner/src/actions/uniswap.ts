import { z } from "zod";
import {
  DEFAULT_SLIPPAGE_BPS,
  UNISWAP_ADDRESSES,
} from "@/lib/uniswap/constants";
import { quoteSwapRoute, resolveSwapRoute } from "@/lib/uniswap/route";
import type { SwapDirection, SwapPair } from "@/lib/uniswap/types";
import { executeSwap } from "../uniswap-action";
import { readBalances } from "../balances";
import {
  actionAnalysisSchema,
  actionResultSchema,
  assetAmount,
  confirmedResult,
  observedQuote,
  type ActionDefinition,
  type Asset,
} from "./types";

const swapPairs = ["ETH_UP", "ETH_USDC", "UP_USDC"] as const;
const swapDirections = ["A_TO_B", "B_TO_A"] as const;

export const uniswapSwapInputSchema = z
  .object({
    pair: z.enum(swapPairs),
    direction: z.enum(swapDirections),
    amountInRaw: z.string().regex(/^[1-9]\d*$/),
    amountOutMinRaw: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
  })
  .strict();
export type UniswapSwapInput = z.infer<typeof uniswapSwapInputSchema>;

const decimals: Record<Asset, number> = { ETH: 18, USDC: 6, UP: 18, DG: 18 };

function assetsFor(pair: SwapPair, direction: SwapDirection): [Asset, Asset] {
  const pairAssets: Record<SwapPair, [Asset, Asset]> = {
    ETH_UP: ["ETH", "UP"],
    ETH_USDC: ["ETH", "USDC"],
    UP_USDC: ["UP", "USDC"],
  };
  const [a, b] = pairAssets[pair];
  return direction === "A_TO_B" ? [a, b] : [b, a];
}

function tokenFor(asset: Asset): `0x${string}` | null {
  if (asset === "ETH") return null;
  if (asset === "USDC") return UNISWAP_ADDRESSES.usdc;
  if (asset === "UP") return UNISWAP_ADDRESSES.up;
  return null;
}

export const uniswapSwapAction: ActionDefinition<UniswapSwapInput> = {
  name: "p2e_uniswap_swap",
  version: 2,
  description:
    "Execute a task-bound or prerequisite Uniswap swap through a verifier-compatible route.",
  taskTypes: ["uniswap_swap"],
  inputSchema: uniswapSwapInputSchema,
  analysisSchema: actionAnalysisSchema,
  resultSchema: actionResultSchema,
  supportsNetwork: (chainId) => chainId === 8453,

  parseTaskConfig(taskConfig) {
    const config = z
      .object({
        pair: z.enum(swapPairs),
        direction: z.enum(swapDirections),
        required_amount_in: z.string().regex(/^[1-9]\d*$/),
      })
      .passthrough()
      .parse(taskConfig);
    return uniswapSwapInputSchema.parse({
      pair: config.pair,
      direction: config.direction,
      amountInRaw: config.required_amount_in,
    });
  },

  async analyze(ctx, input) {
    const parsed = uniswapSwapInputSchema.parse(input);
    const route = resolveSwapRoute(parsed.pair, parsed.direction);
    const [inputAsset, outputAsset] = assetsFor(parsed.pair, parsed.direction);
    const balances = await readBalances(ctx.wallet);
    const requiredRaw = BigInt(parsed.amountInRaw);
    const availableRaw = balances[inputAsset];
    const deficitRaw =
      requiredRaw > availableRaw ? requiredRaw - availableRaw : 0n;
    const blockNumber = await ctx.wallet.publicClient.getBlockNumber();
    const quotedRaw = await quoteSwapRoute(
      ctx.wallet.publicClient,
      route,
      requiredRaw,
    );
    const slippageBps = BigInt(ctx.config.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
    const minOut = quotedRaw - (quotedRaw * slippageBps) / 10_000n;

    return actionAnalysisSchema.parse({
      executableNow: deficitRaw === 0n,
      requirements: [
        {
          reference: {
            kind: "asset",
            asset: inputAsset,
            requiredRaw: requiredRaw.toString(),
            deficitRaw: deficitRaw.toString(),
          },
          required: assetAmount(
            inputAsset,
            requiredRaw,
            decimals[inputAsset],
            tokenFor(inputAsset),
          ),
          available: assetAmount(
            inputAsset,
            availableRaw,
            decimals[inputAsset],
            tokenFor(inputAsset),
          ),
          deficit: assetAmount(
            inputAsset,
            deficitRaw,
            decimals[inputAsset],
            tokenFor(inputAsset),
          ),
        },
      ],
      effects: [
        {
          kind: "asset",
          asset: assetAmount(
            outputAsset,
            minOut,
            decimals[outputAsset],
            tokenFor(outputAsset),
          ),
          estimatedChangeRaw: minOut.toString(),
        },
      ],
      blockers:
        deficitRaw > 0n
          ? [
              {
                code: "INSUFFICIENT_BALANCE",
                message: `The wallet lacks ${deficitRaw} raw ${inputAsset}.`,
                resolution: "agent",
              },
            ]
          : [],
      gasEstimateRaw: null,
      quote: observedQuote("rpc", blockNumber, new Date(Date.now() + 60_000)),
    });
  },

  async execute(ctx, input) {
    if (!this.supportsNetwork(ctx.config.chainId)) {
      return actionResultSchema.parse({
        status: "fatal_error",
        code: "UNSUPPORTED_CHAIN",
        message: `Uniswap agent actions require Base mainnet, received ${ctx.config.chainId}.`,
      });
    }
    const parsed = uniswapSwapInputSchema.parse(input);
    const execution = await executeSwap(
      ctx.wallet,
      ctx.config,
      {
        pair: parsed.pair,
        direction: parsed.direction,
        amountIn: BigInt(parsed.amountInRaw),
        amountOutMin: parsed.amountOutMinRaw
          ? BigInt(parsed.amountOutMinRaw)
          : undefined,
        slippageBps: ctx.config.slippageBps,
      },
      ctx.onTransactionPrepared
        ? (approvals) => ctx.onTransactionPrepared!({ approvals })
        : undefined,
      ctx.onApprovalTransaction,
    );
    await ctx.onTransactionSubmitted?.(execution);
    const receipt = await ctx.wallet.waitForReceipt(execution.txHash);
    if (receipt.status !== "success") {
      return actionResultSchema.parse({
        status: "state_changed",
        code: "TX_REVERTED",
        message: "The swap reverted; observe current state before retrying.",
      });
    }
    return confirmedResult(execution.txHash, execution.approvals);
  },
};
