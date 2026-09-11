import { assessAdmission } from "./admission";
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
  address: "0x1111111111111111111111111111111111111111",
  caip2: "eip155:8453",
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
  const assessment = await assessAdmission(wallet, config, run);
  expect(assessment.blockers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        class: "funding",
        code: "INSUFFICIENT_FUNDING",
      }),
    ]),
  );
  expect(assessment.funding.deficits).toEqual(
    expect.arrayContaining([expect.objectContaining({ asset: "USDC" })]),
  );
  expect(assessment.overridable).toBe(true);
});

it("requires gas even for a token-funded task", async () => {
  observe.mockResolvedValue(observation({ balances: { ETH: 0n } }));
  const assessment = await assessAdmission(wallet, config, run);
  expect(assessment.blockers).toEqual(
    expect.arrayContaining([expect.objectContaining({ class: "funding" })]),
  );
});

it("adds combined task spending to the API reserve", async () => {
  observe.mockResolvedValue(
    observation({ requirements: { USDC: "120000000" } }),
  );
  const assessment = await assessAdmission(wallet, config, {
    daily_quest_run_tasks: [
      ...run.daily_quest_run_tasks,
      ...run.daily_quest_run_tasks,
    ],
  });
  expect(assessment.funding.deficits).toEqual(
    expect.arrayContaining([expect.objectContaining({ asset: "USDC" })]),
  );
});

it("admits funded tasks after candidate analysis", async () => {
  expect(await assessAdmission(wallet, config, run)).toMatchObject({
    admissible: true,
    overridable: false,
    blockers: [],
    economics: { method: "heuristic" },
  });
  expect(observe).toHaveBeenCalled();
});

it("propagates RPC outages instead of admitting an unknown balance", async () => {
  observe.mockRejectedValue(new Error("RPC unavailable"));
  await expect(assessAdmission(wallet, config, run)).rejects.toThrow(
    "RPC unavailable",
  );
});

it("analyses the run once rather than twice per gate", async () => {
  await assessAdmission(wallet, config, run);
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
  expect(await assessAdmission(wallet, config, run)).toMatchObject({
    admissible: false,
    overridable: false,
    blockers: [
      {
        class: "invariant",
        code: "UNSUPPORTED_CHAIN",
        message: "Wrong chain.",
      },
    ],
  });
});

it("surfaces an owner blocker once funding is sufficient", async () => {
  observe.mockResolvedValue(
    observation({
      ownerBlockers: [
        {
          taskId: "task",
          code: "OWNER_ACTION_REQUIRED",
          message: "Do it in the app.",
        },
      ],
    }),
  );
  expect(await assessAdmission(wallet, config, run)).toMatchObject({
    admissible: false,
    overridable: false,
    blockers: [
      {
        class: "owner",
        code: "OWNER_ACTION_REQUIRED",
        message: "Do it in the app.",
      },
    ],
  });
});
