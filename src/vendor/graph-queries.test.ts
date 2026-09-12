/**
 * @jest-environment node
 */

import { normalizeSwaps, normalizeVendorActivity } from "./graph-queries";

function vendorEvent(account: string, id: string) {
  return {
    id,
    account: { id: account },
    timestamp: "1700000000",
    txHash: `0x${id}`,
    baseTokenAmount: "1000000000000000000",
    swapTokenAmount: "2000000000000000000",
  };
}

describe("normalizeVendorActivity", () => {
  it("carries the wallet each event belongs to", () => {
    const { events } = normalizeVendorActivity({
      purchases: [vendorEvent("0xOWNER", "p1")],
      sales: [vendorEvent("0xAGENT", "s1")],
    });

    expect(events.map((event) => [event.kind, event.account])).toEqual([
      ["purchase", "0xowner"],
      ["sale", "0xagent"],
    ]);
  });

  it("keeps totals per wallet rather than merging them", () => {
    const { totals } = normalizeVendorActivity({
      vendorAccounts: [
        {
          id: "0xOWNER",
          stage: 2,
          totalBought: "100",
          totalSold: "10",
          lightUpCount: 1,
        },
        {
          id: "0xAGENT",
          stage: 5,
          totalBought: "7",
          totalSold: "0",
          lightUpCount: 3,
        },
      ],
    });

    expect(totals).toEqual([
      {
        account: "0xowner",
        stage: 2,
        totalBought: "100",
        totalSold: "10",
        lightUpCount: 1,
      },
      {
        account: "0xagent",
        stage: 5,
        totalBought: "7",
        totalSold: "0",
        lightUpCount: 3,
      },
    ]);
  });

  it("returns no totals for an empty response rather than a null shape", () => {
    expect(normalizeVendorActivity({})).toEqual({ totals: [], events: [] });
    expect(normalizeVendorActivity(null)).toEqual({ totals: [], events: [] });
  });

  it("rejects an event with no account instead of guessing one", () => {
    expect(() =>
      normalizeVendorActivity({
        purchases: [{ id: "p1", timestamp: "1", txHash: "0x1" }],
      }),
    ).toThrow();
  });
});

function swap(amount0: string, amount1: string) {
  return {
    id: "s1",
    timestamp: "1700000000",
    amount0,
    amount1,
    amountUSD: "12.5",
    origin: "0xORIGIN",
    transaction: { id: "0xtx" },
    token0: { symbol: "USDC" },
    token1: { symbol: "UP" },
  };
}

describe("normalizeSwaps", () => {
  it("names what was paid and what was received", () => {
    const [filled] = normalizeSwaps({ swaps: [swap("0.200000", "-1234.5")] });

    expect(filled!.tokenIn).toEqual({ symbol: "USDC", amount: "0.200000" });
    expect(filled!.tokenOut).toEqual({ symbol: "UP", amount: "1234.5" });
  });

  it("reads the other direction from the other sign", () => {
    const [filled] = normalizeSwaps({ swaps: [swap("-0.200000", "1234.5")] });

    expect(filled!.tokenIn).toEqual({ symbol: "UP", amount: "1234.5" });
    expect(filled!.tokenOut).toEqual({ symbol: "USDC", amount: "0.200000" });
  });

  it("strips the sign without going through a float", () => {
    const exact = "123456789012345678.123456789012345678";
    const [filled] = normalizeSwaps({ swaps: [swap(`-${exact}`, "1")] });

    expect(filled!.tokenOut.amount).toBe(exact);
  });

  it("keeps the raw signed amounts alongside the derived pair", () => {
    const [filled] = normalizeSwaps({ swaps: [swap("0.2", "-1234.5")] });

    expect(filled!.amount0).toBe("0.2");
    expect(filled!.amount1).toBe("-1234.5");
    expect(filled!.origin).toBe("0xorigin");
  });
});
