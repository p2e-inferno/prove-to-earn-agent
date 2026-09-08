/**
 * @jest-environment node
 */

import { resolveSwapRoute } from "@/lib/uniswap/route";
import { UNISWAP_ADDRESSES } from "@/lib/uniswap/constants";
import { poolsForPair } from "../uniswap-action";
import { uniswapSwapAction } from "./uniswap";
import type { SwapDirection, SwapPair } from "@/lib/uniswap/types";

const PAIRS: SwapPair[] = ["ETH_UP", "ETH_USDC", "UP_USDC"];
const DIRECTIONS: SwapDirection[] = ["A_TO_B", "B_TO_A"];

describe("route parity with the verifier", () => {
  it.each(PAIRS.flatMap((pair) => DIRECTIONS.map((d) => [pair, d] as const)))(
    "builds a route for %s %s",
    (pair, direction) => {
      const route = resolveSwapRoute(pair, direction);

      expect(route.tokenIn).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(route.tokenOut).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(route.tokenIn).not.toBe(route.tokenOut);
      expect(route.path.length).toBeGreaterThan(2);
    },
  );

  it("routes UP_USDC as a multi-hop through WETH in both directions", () => {
    const forward = resolveSwapRoute("UP_USDC", "A_TO_B");
    const back = resolveSwapRoute("UP_USDC", "B_TO_A");

    // Rejecting this as unsupported was the defect: it is a valid route the
    // verifier accepts, and refusing it stranded every UP-funded task.
    expect(forward.multihop).toBe(true);
    expect(back.multihop).toBe(true);
    expect(forward.tokenIn).toBe(UNISWAP_ADDRESSES.up);
    expect(forward.tokenOut).toBe(UNISWAP_ADDRESSES.usdc);
    expect(back.tokenIn).toBe(UNISWAP_ADDRESSES.usdc);
    expect(back.tokenOut).toBe(UNISWAP_ADDRESSES.up);
  });

  it("keeps direct routes single-hop", () => {
    expect(resolveSwapRoute("ETH_UP", "A_TO_B").multihop).toBe(false);
    expect(resolveSwapRoute("ETH_USDC", "A_TO_B").multihop).toBe(false);
  });

  it("reverses the encoded path when the direction flips", () => {
    const forward = resolveSwapRoute("UP_USDC", "A_TO_B");
    const back = resolveSwapRoute("UP_USDC", "B_TO_A");

    expect(forward.path).not.toBe(back.path);
  });

  it("measures every pool a multi-hop route actually crosses", () => {
    // The thinnest leg bounds the trade, so a single-pool read would miss it.
    expect(poolsForPair("UP_USDC")).toHaveLength(2);
    expect(poolsForPair("ETH_UP")).toHaveLength(1);
    expect(poolsForPair("ETH_USDC")).toHaveLength(1);
  });

  it("marks native input and output only on the ETH side", () => {
    expect(resolveSwapRoute("ETH_UP", "A_TO_B").nativeInput).toBe(true);
    expect(resolveSwapRoute("ETH_UP", "B_TO_A").nativeOutput).toBe(true);
    expect(resolveSwapRoute("UP_USDC", "A_TO_B").nativeInput).toBe(false);
    expect(resolveSwapRoute("UP_USDC", "B_TO_A").nativeOutput).toBe(false);
  });
});

describe("uniswap task config", () => {
  it("accepts every supported pair and direction", () => {
    for (const pair of PAIRS) {
      for (const direction of DIRECTIONS) {
        expect(
          uniswapSwapAction.parseTaskConfig({
            pair,
            direction,
            required_amount_in: "1000",
          }),
        ).toMatchObject({ pair, direction, amountInRaw: "1000" });
      }
    }
  });

  it.each([
    { pair: "DOGE_MOON", direction: "A_TO_B", required_amount_in: "1" },
    { pair: "ETH_UP", direction: "SIDEWAYS", required_amount_in: "1" },
    { pair: "ETH_UP", direction: "A_TO_B", required_amount_in: "0" },
    { pair: "ETH_UP", direction: "A_TO_B" },
  ])("refuses %p", (config) => {
    expect(() => uniswapSwapAction.parseTaskConfig(config)).toThrow();
  });
});
