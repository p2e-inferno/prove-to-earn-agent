import { encodeSwapWithFeeManual } from "@/lib/uniswap/encode-swap";
import {
  UNISWAP_ADDRESSES,
  FEE_CONFIG,
  ROUTE_CONFIG,
  DEFAULT_DEADLINE_SECONDS,
  DEFAULT_SLIPPAGE_BPS,
} from "@/lib/uniswap/constants";
import { quoteSwapRoute, resolveSwapRoute } from "@/lib/uniswap/route";
import { getDataSuffix } from "@/lib/blockchain/attribution";
import type { SwapDirection, SwapPair } from "@/lib/uniswap/types";
import type { AgentWallet } from "./wallet";
import { ensureSwapApprovals, type ApprovalStep } from "./approvals";
import type { RunnerConfig } from "./config";

export interface SwapRequest {
  pair: SwapPair;
  direction: SwapDirection;
  amountIn: bigint;
  /** Overrides the quoted minimum. Omit to quote on-chain and apply slippage. */
  amountOutMin?: bigint;
  slippageBps?: number;
}

/**
 * Executes the exact swap shape the gateway's verifier accepts.
 *
 * Deliberately not AgentKit's generic trade actions: the verifier requires
 * `receipt.to === universalRouter` plus specific pools and route shape, so an
 * economically better aggregator route would be rejected. Reusing the app's own
 * encoder is what keeps them in step, and the builder-code suffix is what keeps
 * Base attribution on agent-driven volume.
 */
export interface SwapExecution {
  txHash: `0x${string}`;
  approvals: ApprovalStep[];
  amountOutMin: bigint;
}

export async function executeSwap(
  wallet: AgentWallet,
  config: RunnerConfig,
  request: SwapRequest,
): Promise<SwapExecution> {
  if (!ROUTE_CONFIG[request.pair]) {
    throw new Error(`Unsupported pair: ${request.pair}`);
  }

  const feeRecipient = FEE_CONFIG.feeRecipient;
  if (!feeRecipient) {
    throw new Error("NEXT_PUBLIC_UNISWAP_FEE_WALLET is not configured");
  }

  const route = resolveSwapRoute(request.pair, request.direction);

  // A zero minimum is an unbounded-loss order. The minimum is quoted on-chain
  // and discounted by the slippage tolerance unless the caller pins it.
  let amountOutMin = request.amountOutMin;
  if (amountOutMin === undefined) {
    const quoted = await quoteSwapRoute(
      wallet.publicClient,
      route,
      request.amountIn,
    );
    const bps = BigInt(request.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
    amountOutMin = quoted - (quoted * bps) / 10_000n;
  }

  if (amountOutMin <= 0n) {
    throw new Error(
      "Refusing to swap with a zero minimum output; the quote returned nothing",
    );
  }

  const { calldata, value } = encodeSwapWithFeeManual({
    tokenOut: route.nativeOutput ? UNISWAP_ADDRESSES.weth : route.tokenOut,
    path: route.path,
    amountIn: request.amountIn,
    amountOutMin,
    recipient: wallet.address,
    feeRecipient: feeRecipient as `0x${string}`,
    feeBips: FEE_CONFIG.feeBips,
    isNativeEthIn: route.nativeInput,
    isNativeEthOut: route.nativeOutput,
    deadline: Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS,
  });

  const suffix = getDataSuffix(config.chainId);
  const data = (
    suffix ? `${calldata}${suffix.slice(2)}` : calldata
  ) as `0x${string}`;

  // Sell directions move an ERC-20, which the router can only pull through
  // Permit2. Without this a UP->ETH or USDC->ETH quest simply reverts.
  const approvals = await ensureSwapApprovals(
    wallet,
    route.tokenIn,
    request.amountIn,
    route.nativeInput,
  );

  const txHash = await wallet.sendTransaction({
    to: UNISWAP_ADDRESSES.universalRouter as `0x${string}`,
    data,
    value,
  });

  return { txHash, approvals, amountOutMin };
}

/**
 * Pools the verifier requires the swap to route through.
 *
 * Mirrors `getPoolAddresses` in lib/quests/verification/uniswap-verification.ts:
 * a swap through any other pool is rejected as ROUTE_MISMATCH, so this is also
 * the only pool worth asking The Graph about.
 */
export function poolsForPair(pair: SwapPair): `0x${string}`[] {
  const { pools } = UNISWAP_ADDRESSES;
  switch (pair) {
    case "ETH_UP":
      return [pools.ETH_UP];
    case "ETH_USDC":
      return [pools.ETH_USDC];
    case "UP_USDC":
      return [pools.ETH_UP, pools.ETH_USDC];
    default:
      return [];
  }
}
