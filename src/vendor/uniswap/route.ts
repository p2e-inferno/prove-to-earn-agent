import { encodePacked, type PublicClient } from "viem";
import { getQuoteExactInput, getQuoteExactInputSingle } from "./quote";
import { ROUTE_CONFIG, UNISWAP_ADDRESSES } from "./constants";
import type { SwapDirection, SwapPair } from "./types";

export interface ResolvedSwapRoute {
  pair: SwapPair;
  direction: SwapDirection;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  path: `0x${string}`;
  nativeInput: boolean;
  nativeOutput: boolean;
  multihop: boolean;
}

export function resolveSwapRoute(
  pair: SwapPair,
  direction: SwapDirection,
): ResolvedSwapRoute {
  const route = ROUTE_CONFIG[pair];
  if (!route) throw new Error(`Unsupported pair: ${pair}`);

  const nativeInput = direction === "A_TO_B" && pair.startsWith("ETH_");
  const nativeOutput = direction === "B_TO_A" && pair.startsWith("ETH_");

  if (pair === "UP_USDC") {
    const forward = direction === "A_TO_B";
    const tokens: readonly [`0x${string}`, `0x${string}`, `0x${string}`] = forward
      ? [UNISWAP_ADDRESSES.up, UNISWAP_ADDRESSES.weth, UNISWAP_ADDRESSES.usdc]
      : [UNISWAP_ADDRESSES.usdc, UNISWAP_ADDRESSES.weth, UNISWAP_ADDRESSES.up];
    const fees: readonly [number, number] = forward ? [3000, 500] : [500, 3000];
    return {
      pair,
      direction,
      tokenIn: tokens[0],
      tokenOut: tokens[2],
      path: encodePacked(
        ["address", "uint24", "address", "uint24", "address"],
        [tokens[0], fees[0], tokens[1], fees[1], tokens[2]],
      ),
      nativeInput,
      nativeOutput,
      multihop: true,
    };
  }

  if (route.kind !== "single") throw new Error(`Invalid route: ${pair}`);
  const [tokenA, tokenB] =
    pair === "ETH_UP"
      ? [UNISWAP_ADDRESSES.weth, UNISWAP_ADDRESSES.up]
      : [UNISWAP_ADDRESSES.weth, UNISWAP_ADDRESSES.usdc];
  const tokenIn = direction === "A_TO_B" ? tokenA : tokenB;
  const tokenOut = direction === "A_TO_B" ? tokenB : tokenA;
  return {
    pair,
    direction,
    tokenIn,
    tokenOut,
    path: encodePacked(
      ["address", "uint24", "address"],
      [tokenIn, route.fee, tokenOut],
    ),
    nativeInput,
    nativeOutput,
    multihop: false,
  };
}

export async function quoteSwapRoute(
  client: PublicClient,
  route: ResolvedSwapRoute,
  amountIn: bigint,
): Promise<bigint> {
  if (route.multihop) {
    return (
      await getQuoteExactInput(client, UNISWAP_ADDRESSES.quoterV2, {
        path: route.path,
        amountIn,
      })
    ).amountOut;
  }

  const config = ROUTE_CONFIG[route.pair];
  if (config.kind !== "single") throw new Error("Invalid single-hop route");
  return (
    await getQuoteExactInputSingle(client, UNISWAP_ADDRESSES.quoterV2, {
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
      fee: config.fee,
      amountIn,
    })
  ).amountOut;
}
