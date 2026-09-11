import { assetAmount } from "./actions/types";
import { runSpendSchema } from "./spend";

function spend() {
  return {
    startingSpendable: [assetAmount("ETH", 1n, 18, null)],
    gasSpent: assetAmount("ETH", 0n, 18, null),
    principalSpent: [],
    apiSpent: assetAmount("USDC", 0n, 6, null),
    fundingSwaps: 0,
    paidCalls: 0,
    guards: {
      maxFundingSwaps: null,
      fundingSwapsRemaining: null,
      maxSteps: 32,
      stepsRemaining: 32,
    },
  };
}

it("normalizes an older spend checkpoint without a discounted-call count", () => {
  expect(runSpendSchema.parse(spend()).discountedCalls).toBe(0);
});

it("rejects a spend ledger that labels API charges as another asset", () => {
  expect(() =>
    runSpendSchema.parse({
      ...spend(),
      apiSpent: assetAmount("ETH", 1n, 18, null),
    }),
  ).toThrow();
});
