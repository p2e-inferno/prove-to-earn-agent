import { encodeFunctionData } from "viem";
import { z } from "zod";
import { ERC20_ABI } from "@/lib/blockchain/shared/abi-definitions";
import {
  actionAnalysisSchema,
  actionEconomics,
  actionResultSchema,
  actionValue,
  assetAmount,
  confirmedResult,
  estimateActionGas,
  observedQuote,
  type ActionDefinition,
  type Asset,
} from "./types";
import { UNISWAP_ADDRESSES } from "@/lib/uniswap/constants";
import { spendableEth } from "../balances";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const ethTransferInputSchema = z
  .object({
    chainId: z.literal(8453),
    to: addressSchema,
    valueRaw: z.string().regex(/^[1-9]\d*$/),
  })
  .strict();
const erc20TransferInputSchema = z
  .object({
    chainId: z.literal(8453),
    tokenAddress: addressSchema,
    to: addressSchema,
    amountRaw: z.string().regex(/^[1-9]\d*$/),
    asset: z.enum(["USDC", "UP", "DG"]),
    decimals: z.number().int().min(0).max(255),
  })
  .strict();

function fixedRecipient(value: unknown): string {
  if (value === "linked_wallet") {
    throw new Error(
      "linked_wallet recipients must be resolved by the server before execution",
    );
  }
  return addressSchema.parse(value);
}

function parseChain(value: unknown): 8453 {
  if (Number(value) !== 8453)
    throw new Error("Agent transfers require Base mainnet");
  return 8453;
}

export const ethTransferAction: ActionDefinition<
  z.infer<typeof ethTransferInputSchema>
> = {
  name: "p2e_eth_transfer",
  version: 1,
  description: "Send the task-configured ETH amount to its fixed recipient.",
  taskTypes: ["eth_transfer"],
  inputSchema: ethTransferInputSchema,
  analysisSchema: actionAnalysisSchema,
  resultSchema: actionResultSchema,
  supportsNetwork: (chainId) => chainId === 8453,
  parseTaskConfig(config) {
    const value = z
      .object({
        chain_id: z.unknown(),
        to: z.unknown(),
        min_value_wei: z.union([z.string(), z.number()]),
      })
      .passthrough()
      .parse(config);
    return ethTransferInputSchema.parse({
      chainId: parseChain(value.chain_id),
      to: fixedRecipient(value.to),
      valueRaw: String(value.min_value_wei),
    });
  },
  async analyze(ctx, input) {
    const parsed = ethTransferInputSchema.parse(input);
    const transaction = {
      to: parsed.to as `0x${string}`,
      data: "0x" as const,
      value: BigInt(parsed.valueRaw),
    };
    const [available, blockNumber, gas] = await Promise.all([
      ctx.wallet.publicClient.getBalance({ address: ctx.wallet.address }),
      ctx.wallet.publicClient.getBlockNumber(),
      estimateActionGas(ctx.wallet, transaction),
    ]);
    const required = BigInt(parsed.valueRaw);
    const spendable = spendableEth(
      available,
      ctx.config.minNativeReserveRaw
        ? BigInt(ctx.config.minNativeReserveRaw)
        : undefined,
    ).spendable;
    const deficit = required > spendable ? required - spendable : 0n;
    return actionAnalysisSchema.parse({
      executableNow: deficit === 0n,
      requirements: [
        {
          reference: {
            kind: "asset",
            asset: "ETH",
            requiredRaw: required.toString(),
            deficitRaw: deficit.toString(),
          },
          required: assetAmount("ETH", required, 18, null),
          available: assetAmount("ETH", spendable, 18, null),
          deficit: assetAmount("ETH", deficit, 18, null),
        },
      ],
      effects: [],
      blockers:
        deficit > 0n
          ? [
              {
                code: "INSUFFICIENT_ETH",
                message:
                  "The wallet lacks spendable ETH after its gas reserve.",
                resolution: "owner",
              },
            ]
          : [],
      gasEstimateRaw: gas.estimateRaw,
      economics: actionEconomics(
        gas,
        actionValue(assetAmount("ETH", required, 18, null)),
      ),
      quote: observedQuote("task_config", blockNumber),
    });
  },
  async execute(ctx, input) {
    const parsed = ethTransferInputSchema.parse(input);
    await ctx.onTransactionPrepared?.({ approvals: [] });
    const txHash = await ctx.wallet.sendTransaction({
      to: parsed.to as `0x${string}`,
      data: "0x",
      value: BigInt(parsed.valueRaw),
    });
    await ctx.onTransactionSubmitted?.({ txHash, approvals: [] });
    const receipt = await ctx.wallet.waitForReceipt(txHash);
    return receipt.status === "success"
      ? confirmedResult(txHash)
      : actionResultSchema.parse({
          status: "state_changed",
          code: "TX_REVERTED",
          message: "ETH transfer reverted.",
        });
  },
};

function inferAsset(token: string): { asset: Asset; decimals: number } {
  if (token.toLowerCase() === UNISWAP_ADDRESSES.usdc.toLowerCase())
    return { asset: "USDC", decimals: 6 };
  if (token.toLowerCase() === UNISWAP_ADDRESSES.up.toLowerCase())
    return { asset: "UP", decimals: 18 };
  return { asset: "DG", decimals: 18 };
}

export const erc20TransferAction: ActionDefinition<
  z.infer<typeof erc20TransferInputSchema>
> = {
  name: "p2e_erc20_transfer",
  version: 1,
  description: "Send the task-configured ERC-20 amount to its fixed recipient.",
  taskTypes: ["erc20_transfer"],
  inputSchema: erc20TransferInputSchema,
  analysisSchema: actionAnalysisSchema,
  resultSchema: actionResultSchema,
  supportsNetwork: (chainId) => chainId === 8453,
  parseTaskConfig(config) {
    const value = z
      .object({
        chain_id: z.unknown(),
        token_address: addressSchema,
        to: z.unknown(),
        min_amount_raw: z.union([z.string(), z.number()]).optional(),
        min_amount: z.union([z.string(), z.number()]).optional(),
      })
      .passthrough()
      .parse(config);
    const inferred = inferAsset(value.token_address);
    return erc20TransferInputSchema.parse({
      chainId: parseChain(value.chain_id),
      tokenAddress: value.token_address,
      to: fixedRecipient(value.to),
      amountRaw: String(value.min_amount_raw ?? value.min_amount),
      ...inferred,
    });
  },
  async analyze(ctx, input) {
    const parsed = erc20TransferInputSchema.parse(input);
    const transferData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [parsed.to as `0x${string}`, BigInt(parsed.amountRaw)],
    });
    const [available, blockNumber, gas] = await Promise.all([
      ctx.wallet.publicClient.readContract({
        address: parsed.tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [ctx.wallet.address],
      }) as Promise<bigint>,
      ctx.wallet.publicClient.getBlockNumber(),
      estimateActionGas(ctx.wallet, {
        to: parsed.tokenAddress as `0x${string}`,
        data: transferData,
      }),
    ]);
    const required = BigInt(parsed.amountRaw);
    const deficit = required > available ? required - available : 0n;
    return actionAnalysisSchema.parse({
      executableNow: deficit === 0n,
      requirements: [
        {
          reference: {
            kind: "asset",
            asset: parsed.asset,
            requiredRaw: required.toString(),
            deficitRaw: deficit.toString(),
          },
          required: assetAmount(
            parsed.asset,
            required,
            parsed.decimals,
            parsed.tokenAddress as `0x${string}`,
          ),
          available: assetAmount(
            parsed.asset,
            available,
            parsed.decimals,
            parsed.tokenAddress as `0x${string}`,
          ),
          deficit: assetAmount(
            parsed.asset,
            deficit,
            parsed.decimals,
            parsed.tokenAddress as `0x${string}`,
          ),
        },
      ],
      effects: [],
      blockers:
        deficit > 0n
          ? [
              {
                code: "INSUFFICIENT_TOKEN",
                message: `The wallet lacks ${deficit} raw ${parsed.asset}.`,
                resolution: parsed.asset === "UP" ? "agent" : "owner",
              },
            ]
          : [],
      gasEstimateRaw: gas.estimateRaw,
      economics: actionEconomics(
        gas,
        actionValue(
          assetAmount(
            parsed.asset,
            required,
            parsed.decimals,
            parsed.tokenAddress as `0x${string}`,
          ),
        ),
      ),
      quote: observedQuote("task_config", blockNumber),
    });
  },
  async execute(ctx, input) {
    const parsed = erc20TransferInputSchema.parse(input);
    await ctx.onTransactionPrepared?.({ approvals: [] });
    const txHash = await ctx.wallet.sendTransaction({
      to: parsed.tokenAddress as `0x${string}`,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [parsed.to as `0x${string}`, BigInt(parsed.amountRaw)],
      }),
    });
    await ctx.onTransactionSubmitted?.({ txHash, approvals: [] });
    const receipt = await ctx.wallet.waitForReceipt(txHash);
    return receipt.status === "success"
      ? confirmedResult(txHash)
      : actionResultSchema.parse({
          status: "state_changed",
          code: "TX_REVERTED",
          message: "ERC-20 transfer reverted.",
        });
  },
};
