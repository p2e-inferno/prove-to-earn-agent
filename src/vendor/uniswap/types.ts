/**
 * Shared TypeScript types for the Uniswap integration.
 */

/** Supported swap pairs — hardcoded for MVP */
export type SwapPair = "ETH_UP" | "ETH_USDC" | "UP_USDC";

/** Pair-relative direction: A_TO_B or B_TO_A */
export type SwapDirection = "A_TO_B" | "B_TO_A";

/** Pool state fetched from on-chain */
export interface PoolState {
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee: number;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tick: number;
}

/** Result from QuoterV2 */
export interface QuoteResult {
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  initializedTicksCrossed: number;
  gasEstimate: bigint;
}

/** Post-processing quote with fee breakdown */
export interface SwapQuote {
  amountOut: bigint;
  feeAmount: bigint;
  userReceives: bigint;
  priceImpact: number;
  gasEstimate: bigint;
}
