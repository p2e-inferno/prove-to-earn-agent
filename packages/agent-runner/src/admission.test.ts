import { checkAdmissionFunding } from "./admission";
import type { Asset } from "./actions/types";
import type { AgentWallet } from "./wallet";
import type { RunnerConfig } from "./config";

const observe = jest.fn();
jest.mock("./candidates", () => ({
  observeCandidates: (...args: unknown[]) => observe(...args),
}));

const decimals: Record<Asset, number> = { ETH: 18, USDC: 6, UP: 18, DG: 18 };

function observation(input: {
  balances?: Partial<Record<Asset, bigint>>;
  requirements?: Partial<Record<Asset, string>>;
  ownerBlockers?: Array<{ taskId: string; code: string; message: string }>;
  fatalBlockers?: Array<{ taskId: string; code: string; message: string }>;
}) {
  const held = {
    ETH: 1000000000000000000n,
    USDC: 100000000n,
    UP: 0n,
    DG: 0n,
    ...input.balances,
  };
  return {
    stateVersion: "v1",
    blockNumber: "1",
    balances: (["ETH", "USDC", "UP", "DG"] as const).map((asset) => ({
      asset,
      tokenAddress: null,
      decimals: decimals[asset],
      raw: held[asset].toString(),
      formatted: "0",
    })),
    assetRequirements: {
      ETH: "0",
      USDC: "0",
      UP: "0",
      DG: "0",
      ...input.requirements,
    },
    candidates: [],
    ownerBlockers: input.ownerBlockers ?? [],
    fatalBlockers: input.fatalBlockers ?? [],
  };
}

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
  observe.mockReset();
  observe.mockResolvedValue(observation({}));
});

it("pauses before paid discovery when the wallet has no API funds", async () => {
  observe.mockResolvedValue(observation({ balances: { USDC: 0n } }));
  expect(await checkAdmissionFunding(wallet, config, run)).toContain(
    "USDC including API payments",
  );
});

it("requires gas even for a token-funded task", async () => {
  observe.mockResolvedValue(observation({ balances: { ETH: 0n } }));
  expect(await checkAdmissionFunding(wallet, config, run)).toContain(
    "ETH including the gas reserve",
  );
});

it("adds combined task spending to the API reserve", async () => {
  observe.mockResolvedValue(
    observation({ requirements: { USDC: "120000000" } }),
  );
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
  observe.mockRejectedValue(new Error("RPC unavailable"));
  await expect(checkAdmissionFunding(wallet, config, run)).rejects.toThrow(
    "RPC unavailable",
  );
});

it("analyses the run once rather than twice per gate", async () => {
  await checkAdmissionFunding(wallet, config, run);
  expect(observe).toHaveBeenCalledTimes(1);
});

it("reports an unrunnable task ahead of any funding shortfall", async () => {
  observe.mockResolvedValue(
    observation({
      balances: { ETH: 0n, USDC: 0n },
      fatalBlockers: [
        { taskId: "task", code: "UNSUPPORTED_CHAIN", message: "Wrong chain." },
      ],
    }),
  );
  expect(await checkAdmissionFunding(wallet, config, run)).toBe("Wrong chain.");
});

it("surfaces an owner blocker once funding is sufficient", async () => {
  observe.mockResolvedValue(
    observation({
      ownerBlockers: [
        { taskId: "task", code: "OWNER_ACTION_REQUIRED", message: "Do it in the app." },
      ],
    }),
  );
  expect(await checkAdmissionFunding(wallet, config, run)).toBe(
    "Do it in the app.",
  );
});
