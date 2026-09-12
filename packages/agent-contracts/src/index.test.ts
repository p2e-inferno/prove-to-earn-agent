import { authorizationPolicyV1Schema, decisionSelectionV1Schema } from ".";

describe("agent contracts", () => {
  it("rejects floating-point enforcement values", () => {
    const result = authorizationPolicyV1Schema.safeParse({
      version: 1,
      chain: "eip155:8453",
      resource: "https://api.example.test",
      templateIds: ["11111111-1111-4111-8111-111111111111"],
      actions: [{ actionId: "p2e_uniswap_swap", version: 2 }],
      assetLimits: [
        {
          asset: "USDC",
          tokenAddress: "0x1111111111111111111111111111111111111111",
          perActionRaw: 10.5,
          perRunRaw: "100",
          rolling24hRaw: "1000",
        },
      ],
      maxGasPerActionRaw: "1",
      maxGasPerRunRaw: "2",
      maxGasRolling24hRaw: "3",
      maxX402PerRequestRaw: "4",
      maxX402PerRunRaw: "5",
      maxX402Rolling24hRaw: "6",
      maxServiceFeePerActionRaw: "0",
      maxServiceFeePerRunRaw: "0",
      maxServiceFeeRolling24hRaw: "0",
      minNativeReserveRaw: "7",
      maxFundingSwapsPerRun: 2,
      maxSlippageBps: 100,
    });
    expect(result.success).toBe(false);
  });

  it("accepts only the three decision coordinates", () => {
    expect(
      decisionSelectionV1Schema.safeParse({
        frameId: "11111111-1111-4111-8111-111111111111",
        candidateId: "cand_1234567890abcdef1234567890abcdef",
        expectedExecutionVersion: 4,
        amount: "999",
      }).success,
    ).toBe(false);
  });
});
