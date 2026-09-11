/**
 * @jest-environment node
 */

import { estimateActionGas } from "./types";

describe("action economics", () => {
  it("publishes measured gas units, price, and native cost", async () => {
    const gas = await estimateActionGas(
      {
        address: "0x0000000000000000000000000000000000000001",
        caip2: "eip155:8453",
        publicClient: {
          estimateGas: jest.fn(async () => 21_000n),
          getGasPrice: jest.fn(async () => 2_000_000n),
        } as never,
      },
      {
        to: "0x0000000000000000000000000000000000000002",
        data: "0x",
      },
    );

    expect(gas).toMatchObject({
      estimateRaw: "21000",
      priceRaw: "2000000",
      costRaw: "42000000000",
      costUsd: null,
      method: "measured",
    });
  });

  it("marks an RPC estimate as unavailable instead of inventing a value", async () => {
    const gas = await estimateActionGas(
      {
        address: "0x0000000000000000000000000000000000000001",
        caip2: "eip155:8453",
        publicClient: {} as never,
      },
      {
        to: "0x0000000000000000000000000000000000000002",
        data: "0x",
      },
    );

    expect(gas).toMatchObject({
      estimateRaw: null,
      priceRaw: null,
      costRaw: null,
      method: "unavailable",
    });
  });
});
