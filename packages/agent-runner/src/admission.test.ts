import { checkAdmissionFunding } from "./admission";
import type { AgentWallet } from "./wallet";
import type { RunnerConfig } from "./config";

const balances = jest.fn();
const analyze = jest.fn();
const observe = jest.fn();
jest.mock("./balances", () => ({
  readBalances: () => balances(),
  GAS_RESERVE_WEI: 100000000000000n,
}));
jest.mock("./actions/registry", () => ({
  actionForTaskType: () => ({
    analyze: (...args: unknown[]) => analyze(...args),
    parseTaskConfig: (value: unknown) => value,
  }),
}));
jest.mock("./candidates", () => ({
  observeCandidates: (...args: unknown[]) => observe(...args),
}));
const wallet = {
  publicClient: { getGasPrice: jest.fn(async () => 1000000n) },
} as unknown as AgentWallet;
const config = { maxFundingSwaps: 0 } as RunnerConfig;
const run = {
  daily_quest_run_tasks: [
    { id: "task", task_type: "swap", title: "Swap", task_config: {} },
  ],
};
beforeEach(() => {
  balances.mockResolvedValue({
    ETH: 1000000000000000000n,
    USDC: 100000000n,
    UP: 0n,
    DG: 0n,
  });
  analyze.mockResolvedValue({ requirements: [] });
  observe.mockResolvedValue({ fatalBlockers: [], ownerBlockers: [] });
});
it("pauses before paid discovery when the wallet has no API funds", async () => {
  balances.mockResolvedValue({
    ETH: 1000000000000000000n,
    USDC: 0n,
    UP: 0n,
    DG: 0n,
  });
  expect(await checkAdmissionFunding(wallet, config, run)).toContain(
    "USDC including API payments",
  );
});
it("requires gas even for a token-funded task", async () => {
  balances.mockResolvedValue({ ETH: 0n, USDC: 100000000n, UP: 0n, DG: 0n });
  expect(await checkAdmissionFunding(wallet, config, run)).toContain(
    "ETH including the gas reserve",
  );
});
it("adds combined task spending to the API reserve", async () => {
  analyze.mockResolvedValue({
    requirements: [
      { reference: { kind: "asset", asset: "USDC", requiredRaw: "60000000" } },
    ],
  });
  expect(
    await checkAdmissionFunding(wallet, config, {
      daily_quest_run_tasks: [
        ...run.daily_quest_run_tasks,
        ...run.daily_quest_run_tasks,
      ],
    }),
  ).toContain("Funding required");
});
it("admits funded tasks after candidate analysis", async () => {
  expect(await checkAdmissionFunding(wallet, config, run)).toBeNull();
  expect(observe).toHaveBeenCalled();
});
it("propagates RPC outages instead of admitting an unknown balance", async () => {
  balances.mockRejectedValue(new Error("RPC unavailable"));
  await expect(checkAdmissionFunding(wallet, config, run)).rejects.toThrow(
    "RPC unavailable",
  );
});
