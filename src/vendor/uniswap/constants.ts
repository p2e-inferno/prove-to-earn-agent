/**
 * Uniswap Integration Constants
 * All contract addresses and fee configuration for Uniswap V3 on Base.
 */

import { base } from "viem/chains";

/** Base Mainnet only — no Sepolia support for Uniswap swaps */
export const UNISWAP_CHAIN = base; // chain ID 8453

/** All contract addresses for Base Mainnet */
export const UNISWAP_ADDRESSES = {
  universalRouter:
    "0x6ff5693b99212da76ad316178a184ab56d299b43" as `0x${string}`,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as `0x${string}`,
  quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as `0x${string}`,
  weth: "0x4200000000000000000000000000000000000006" as `0x${string}`,
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
  up: "0xaC27fa800955849d6D17cC8952Ba9dD6EAA66187" as `0x${string}`,
  pools: {
    ETH_UP:
      "0x9EF81F4E2F2f15Ff1c0C3f8c9ECc636580025242" as `0x${string}`,
    ETH_USDC:
      "0xd0b53D9277642d899DF5C87A3966A349A798F224" as `0x${string}`,
    UP_USDC_3000:
      "0x9079070042bc24b4978516706b8b38c77b4f774f" as `0x${string}`,
    UP_USDC_10000:
      "0x26fB74bd19Fdb3833F4C05194673A19A85E46b5e" as `0x${string}`,
  },
} as const;

/**
 * Route config for each pair.
 * - single-hop routes use one fee tier
 * - multi-hop routes define an ordered path through intermediate tokens
 */
export const ROUTE_CONFIG = {
  ETH_UP: {
    tokenA: "ETH",
    tokenB: "UP",
    kind: "single" as const,
    fee: 3000,
  },
  ETH_USDC: {
    tokenA: "ETH",
    tokenB: "USDC",
    kind: "single" as const,
    fee: 500,
  },
  UP_USDC: {
    tokenA: "UP",
    tokenB: "USDC",
    kind: "multihop" as const,
    hops: [
      {
        tokenIn: UNISWAP_ADDRESSES.up,
        tokenOut: UNISWAP_ADDRESSES.weth,
        fee: 3000,
      },
      {
        tokenIn: UNISWAP_ADDRESSES.weth,
        tokenOut: UNISWAP_ADDRESSES.usdc,
        fee: 500,
      },
    ],
  },
} as const;

/** Frontend fee configuration */
export const FEE_CONFIG = {
  /** Fee in basis points (25 = 0.25%), sourced from env var */
  feeBips: Number(process.env.NEXT_PUBLIC_UNISWAP_FEE_BIPS || 25),
  /** Fee recipient wallet address — from env var */
  feeRecipient: process.env
    .NEXT_PUBLIC_UNISWAP_FEE_WALLET as `0x${string}`,
} as const;

/** Default slippage tolerance in basis points */
export const DEFAULT_SLIPPAGE_BPS = 150; // 1.5%

/** Transaction deadline in seconds (10 min) */
export const DEFAULT_DEADLINE_SECONDS = 600;

/**
 * Resolve which pool token is WETH and which is the "other" token.
 *
 * Uniswap V3 pools order tokens by address (lower address = token0).
 * We MUST compare against the known WETH address — never assume token0/token1 ordering.
 */
export function resolvePoolTokens(
  token0: `0x${string}`,
  token1: `0x${string}`,
): { wethToken: `0x${string}`; otherToken: `0x${string}` } {
  const weth = UNISWAP_ADDRESSES.weth.toLowerCase();
  const isToken0Weth = token0.toLowerCase() === weth;
  const isToken1Weth = token1.toLowerCase() === weth;

  if (!isToken0Weth && !isToken1Weth) {
    throw new Error(
      `Neither pool token matches WETH (${UNISWAP_ADDRESSES.weth}). ` +
        `Got token0=${token0}, token1=${token1}. Check pool address configuration.`,
    );
  }

  return {
    wethToken: isToken0Weth ? token0 : token1,
    otherToken: isToken0Weth ? token1 : token0,
  };
}

/**
 * Validate that the fee recipient address is configured.
 * Must be called before any swap execution.
 */
export function validateFeeConfig(): void {
  if (!FEE_CONFIG.feeRecipient || (FEE_CONFIG.feeRecipient as string) === "undefined") {
    throw new Error(
      "NEXT_PUBLIC_UNISWAP_FEE_WALLET is not configured. " +
        "Set this environment variable to the treasury address before enabling swaps.",
    );
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(FEE_CONFIG.feeRecipient)) {
    throw new Error(
      `NEXT_PUBLIC_UNISWAP_FEE_WALLET is not a valid address: ${FEE_CONFIG.feeRecipient}`,
    );
  }
  if (
    Number.isNaN(FEE_CONFIG.feeBips) ||
    !Number.isInteger(FEE_CONFIG.feeBips) ||
    FEE_CONFIG.feeBips < 0 ||
    FEE_CONFIG.feeBips > 10_000
  ) {
    throw new Error(
      `NEXT_PUBLIC_UNISWAP_FEE_BIPS must be an integer 0-10000, got: ${FEE_CONFIG.feeBips}`,
    );
  }
}
