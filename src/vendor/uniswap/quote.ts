/**
 * Fetches price quotes from Uniswap V3 QuoterV2.
 * Uses simulateContract (view) — no gas cost.
 */

import type { PublicClient } from "viem";
import { QUOTER_V2_ABI } from "./abi/quoter-v2";
import type { QuoteResult } from "./types";

export async function getQuoteExactInputSingle(
  publicClient: PublicClient,
  quoterAddress: `0x${string}`,
  params: {
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    fee: number;
    amountIn: bigint;
  },
): Promise<QuoteResult> {
  const result = await publicClient.simulateContract({
    address: quoterAddress,
    abi: QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        fee: params.fee,
        amountIn: params.amountIn,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

  const [amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate] =
    result.result as [bigint, bigint, number, bigint];

  return { amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate };
}

export async function getQuoteExactInput(
  publicClient: PublicClient,
  quoterAddress: `0x${string}`,
  params: {
    path: `0x${string}`;
    amountIn: bigint;
  },
): Promise<QuoteResult> {
  const result = await publicClient.simulateContract({
    address: quoterAddress,
    abi: QUOTER_V2_ABI,
    functionName: "quoteExactInput",
    args: [params.path, params.amountIn],
  });

  const [amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList, gasEstimate] =
    result.result as [bigint, bigint[], number[], bigint];

  const sqrtPriceX96After =
    sqrtPriceX96AfterList[sqrtPriceX96AfterList.length - 1] ?? 0n;
  const initializedTicksCrossed = initializedTicksCrossedList.reduce(
    (acc, v) => acc + v,
    0,
  );

  return { amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate };
}
