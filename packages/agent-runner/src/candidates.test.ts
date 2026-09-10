/**
 * @jest-environment node
 */

const readBalances = jest.fn();
const quoteSwapRoute = jest.fn();
const analyze = jest.fn();
const execute = jest.fn();
const upRequiredForDg = jest.fn();
const qualifyingBuyForPoints = jest.fn();

jest.mock("./balances", () => ({
  ...jest.requireActual("./balances"),
  readBalances: (...args: unknown[]) => readBalances(...args),
}));

jest.mock("@/lib/uniswap/route", () => ({
  ...jest.requireActual("@/lib/uniswap/route"),
  quoteSwapRoute: (...args: unknown[]) => quoteSwapRoute(...args),
}));

// Only the vendor read is replaced; the action objects stay the real ones the
// registry binds, so spying on them still reaches the same instances.
jest.mock("./actions/vendor", () => ({
  ...jest.requireActual("./actions/vendor"),
  upRequiredForDg: (...args: unknown[]) => upRequiredForDg(...args),
  qualifyingBuyForPoints: (...args: unknown[]) =>
    qualifyingBuyForPoints(...args),
}));

import { observeCandidates, executeCandidate } from "./candidates";
import { actionByName, actionForTaskType } from "./actions/registry";
import type { AgentWallet } from "./wallet";
import type { RunnerConfig } from "./config";
import type { ActionCandidate, ActionContext } from "./actions/types";

const getBlockNumber = jest.fn();

const wallet = {
  address: "0x0000000000000000000000000000000000000a9e",
  publicClient: { getBlockNumber },
} as unknown as AgentWallet;

const config = { chainId: 8453 } as unknown as RunnerConfig;

const ONE_ETH = 10n ** 18n;

const buyTask = {
  id: "t-buy",
  title: "Buy DG",
  taskType: "vendor_buy",
  taskConfig: { required_amount: "1000" },
};

const sellTask = {
  id: "t-sell",
  title: "Sell DG",
  taskType: "vendor_sell",
  taskConfig: { required_amount: "1000" },
};

const levelUpTask = {
  id: "t-level",
  title: "Level up",
  taskType: "vendor_level_up",
  taskConfig: {},
};

/** An analysis short of one asset, which is what triggers funding candidates. */
function analysisWithDeficit(deficitRaw: string, asset: "UP" | "DG" = "UP") {
  return {
    executableNow: false,
    requirements: [
      {
        reference: {
          kind: "asset",
          asset,
          requiredRaw: "1000",
          deficitRaw,
        },
        deficit: {
          asset,
          tokenAddress: null,
          decimals: 18,
          raw: deficitRaw,
          formatted: "0",
        },
      },
    ],
    effects: [],
    blockers: [
      { code: `INSUFFICIENT_${asset}`, message: "short", resolution: "agent" },
    ],
    gasEstimateRaw: null,
    quote: {
      source: "contract",
      blockNumber: "1",
      observedAt: new Date().toISOString(),
      expiresAt: null,
    },
  };
}

/** A level-up short of fuel: a shortfall that is not an asset at all. */
function analysisShortOfFuel(deficitRaw: string) {
  return {
    executableNow: false,
    requirements: [
      { reference: { kind: "points", requiredRaw: "10", deficitRaw: "0" } },
      { reference: { kind: "fuel", requiredRaw: "10", deficitRaw } },
    ],
    effects: [],
    blockers: [
      { code: "INSUFFICIENT_FUEL", message: "short", resolution: "agent" },
    ],
    gasEstimateRaw: null,
    quote: {
      source: "contract",
      blockNumber: "1",
      observedAt: new Date().toISOString(),
      expiresAt: null,
    },
  };
}

function analysisShortOfPoints(deficitRaw: string) {
  return {
    ...analysisShortOfFuel("0"),
    requirements: [
      { reference: { kind: "points", requiredRaw: "10", deficitRaw } },
    ],
    blockers: [
      { code: "INSUFFICIENT_POINTS", message: "short", resolution: "agent" },
    ],
  };
}

function readyAnalysis() {
  return {
    executableNow: true,
    requirements: [],
    effects: [],
    blockers: [],
    gasEstimateRaw: null,
    quote: {
      source: "contract",
      blockNumber: "1",
      observedAt: new Date().toISOString(),
      expiresAt: null,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  getBlockNumber.mockResolvedValue(100n);
  readBalances.mockResolvedValue({
    ETH: ONE_ETH,
    USDC: 20_000_000n,
    UP: 0n,
    DG: 0n,
  });
  // A linear quote: one unit in, one unit out, so binary search converges.
  quoteSwapRoute.mockImplementation(
    async (_client: unknown, _route: unknown, amountIn: bigint) => amountIn,
  );
  qualifyingBuyForPoints.mockResolvedValue(1000n);

  const vendorBuy = actionForTaskType("vendor_buy")!;
  jest
    .spyOn(vendorBuy, "analyze")
    .mockImplementation((...args) => analyze(...args));
  const swap = actionByName("p2e_uniswap_swap")!;
  jest.spyOn(swap, "analyze").mockResolvedValue(readyAnalysis() as never);
  jest.spyOn(swap, "execute").mockImplementation((...args) => execute(...args));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("observeCandidates", () => {
  it("offers the quest task itself when nothing blocks it", async () => {
    analyze.mockResolvedValue(readyAnalysis());

    const observation = await observeCandidates({
      wallet,
      config,
      tasks: [buyTask],
    });

    expect(observation.candidates).toHaveLength(1);
    expect(observation.candidates[0]).toMatchObject({
      purpose: { kind: "quest_task", taskId: "t-buy" },
    });
  });

  it("sizes funding to survive the fee and slippage, not to the bare quote", async () => {
    analyze.mockResolvedValue(analysisWithDeficit("500"));

    const observation = await observeCandidates({
      wallet,
      config,
      tasks: [buyTask],
    });

    const funding = observation.candidates.filter(
      (candidate) => candidate.purpose.kind === "prerequisite",
    );
    expect(funding.length).toBeGreaterThan(0);
    for (const candidate of funding) {
      // 500 grossed up past the 0.25% output fee and 1.5% slippage floor.
      // Sizing to 500 exactly lands short, and the remainder becomes another
      // swap; overfunding past this spends on something no task needs.
      expect(
        BigInt((candidate.input as { amountInRaw: string }).amountInRaw),
      ).toBe(510n);
      expect(candidate.purpose).toMatchObject({
        kind: "prerequisite",
        forTaskId: "t-buy",
      });
    }
  });

  it("resolves a DG shortfall by buying the DG, not by giving up", async () => {
    const sell = actionForTaskType("vendor_sell")!;
    jest
      .spyOn(sell, "analyze")
      .mockResolvedValue(analysisWithDeficit("500", "DG") as never);
    upRequiredForDg.mockResolvedValue(400n);
    const buy = actionByName("p2e_vendor_buy")!;
    jest.spyOn(buy, "analyze").mockResolvedValue(readyAnalysis() as never);

    const observation = await observeCandidates({
      wallet,
      config,
      tasks: [sellTask],
    });

    const prep = observation.candidates.filter(
      (candidate) => candidate.purpose.kind === "prerequisite",
    );
    expect(prep.map((candidate) => candidate.actionName)).toEqual([
      "p2e_vendor_buy",
    ]);
    expect(prep[0]!.input).toMatchObject({ amountRaw: "400" });
    expect(prep[0]!.purpose).toMatchObject({ forTaskId: "t-sell" });
  });

  it("funds the buy that a DG shortfall needs, one step further down", async () => {
    const sell = actionForTaskType("vendor_sell")!;
    jest
      .spyOn(sell, "analyze")
      .mockResolvedValue(analysisWithDeficit("500", "DG") as never);
    upRequiredForDg.mockResolvedValue(400n);
    const buy = actionByName("p2e_vendor_buy")!;
    jest
      .spyOn(buy, "analyze")
      .mockResolvedValue(analysisWithDeficit("400") as never);

    const observation = await observeCandidates({
      wallet,
      config,
      tasks: [sellTask],
    });

    const prep = observation.candidates.filter(
      (candidate) => candidate.purpose.kind === "prerequisite",
    );
    expect(prep.length).toBeGreaterThan(0);
    // USDC/ETH -> UP -> DG -> sell, without the planner knowing any of it.
    for (const candidate of prep) {
      expect(candidate.actionName).toBe("p2e_uniswap_swap");
      expect(candidate.purpose).toMatchObject({ forTaskId: "t-sell" });
    }
  });

  it("offers a light-up for the fuel a level-up is short of", async () => {
    const levelUp = actionForTaskType("vendor_level_up")!;
    jest
      .spyOn(levelUp, "analyze")
      .mockResolvedValue(analysisShortOfFuel("7") as never);
    const lightUp = actionByName("p2e_vendor_light_up")!;
    jest.spyOn(lightUp, "analyze").mockResolvedValue(readyAnalysis() as never);

    const observation = await observeCandidates({
      wallet,
      config,
      tasks: [levelUpTask],
    });

    // The light-up is preparation here, never a completion of the level-up.
    expect(observation.candidates).toHaveLength(1);
    expect(observation.candidates[0]).toMatchObject({
      actionName: "p2e_vendor_light_up",
      purpose: { kind: "prerequisite", forTaskId: "t-level" },
    });
  });

  it("offers a qualifying buy for the points a level-up is short of", async () => {
    const levelUp = actionForTaskType("vendor_level_up")!;
    jest
      .spyOn(levelUp, "analyze")
      .mockResolvedValue(analysisShortOfPoints("7") as never);
    const buy = actionByName("p2e_vendor_buy")!;
    jest.spyOn(buy, "analyze").mockResolvedValue(readyAnalysis() as never);

    const observation = await observeCandidates({
      wallet,
      config,
      tasks: [levelUpTask],
    });

    expect(observation.candidates[0]).toMatchObject({
      actionName: "p2e_vendor_buy",
      input: { amountRaw: "1000" },
      purpose: { kind: "prerequisite", forTaskId: "t-level" },
    });
  });

  it("keeps a gas reserve rather than spending the last of the ETH", async () => {
    readBalances.mockResolvedValue({
      ETH: 50_000_000_000_000n,
      USDC: 0n,
      UP: 0n,
      DG: 0n,
    });
    analyze.mockResolvedValue(analysisWithDeficit("500"));

    const observation = await observeCandidates({
      wallet,
      config,
      tasks: [buyTask],
    });

    // The reserve exceeds the balance, so no ETH route may be offered; a swap
    // that leaves nothing for gas strands every later task.
    expect(observation.candidates).toHaveLength(0);
  });

  it("offers no funding route it cannot actually afford", async () => {
    readBalances.mockResolvedValue({ ETH: 0n, USDC: 0n, UP: 0n, DG: 0n });
    analyze.mockResolvedValue(analysisWithDeficit("500"));

    const observation = await observeCandidates({
      wallet,
      config,
      tasks: [buyTask],
    });

    expect(observation.candidates).toEqual([]);
    expect(observation.ownerBlockers).toEqual([
      expect.objectContaining({ code: "OWNER_PREREQUISITE_UNAVAILABLE" }),
    ]);
  });

  it("routes an owner-resolvable blocker to the owner, not to a candidate", async () => {
    analyze.mockResolvedValue({
      ...readyAnalysis(),
      executableNow: false,
      blockers: [
        {
          code: "AGENT_WALLET_NOT_KEYHOLDER",
          message: "needs a key",
          resolution: "owner",
        },
      ],
    });

    const observation = await observeCandidates({
      wallet,
      config,
      tasks: [buyTask],
    });

    expect(observation.candidates).toEqual([]);
    expect(observation.ownerBlockers).toEqual([
      {
        taskId: "t-buy",
        code: "AGENT_WALLET_NOT_KEYHOLDER",
        message: "needs a key",
      },
    ]);
  });

  it("treats a task type it cannot perform as owner work", async () => {
    const observation = await observeCandidates({
      wallet,
      config,
      tasks: [
        {
          id: "t-x",
          title: "Upload proof",
          taskType: "proof_upload",
          taskConfig: {},
        },
      ],
    });

    expect(observation.ownerBlockers[0]).toMatchObject({
      taskId: "t-x",
      code: "OWNER_ACTION_REQUIRED",
    });
  });

  it("reports a misconfigured task as fatal rather than guessing", async () => {
    const observation = await observeCandidates({
      wallet,
      config,
      tasks: [
        {
          id: "t-bad",
          title: "Swap",
          taskType: "uniswap_swap",
          taskConfig: { pair: "DOGE_MOON" },
        },
      ],
    });

    expect(observation.fatalBlockers[0]).toMatchObject({
      taskId: "t-bad",
      code: "INVALID_TASK_CONFIG",
    });
    expect(observation.candidates).toEqual([]);
  });

  it("skips a task already settled, so it is never repeated", async () => {
    analyze.mockResolvedValue(readyAnalysis());

    const observation = await observeCandidates({
      wallet,
      config,
      tasks: [buyTask],
      settledTaskIds: new Set(["t-buy"]),
    });

    expect(observation.candidates).toEqual([]);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("withholds a candidate that already failed to make progress", async () => {
    analyze.mockResolvedValue(readyAnalysis());
    const first = await observeCandidates({ wallet, config, tasks: [buyTask] });
    const rejected = first.candidates[0]!.candidateId;

    const second = await observeCandidates({
      wallet,
      config,
      tasks: [buyTask],
      rejectedCandidateIds: new Set([rejected]),
    });

    // Re-offering it is how a planner loops without the run advancing.
    expect(second.candidates).toEqual([]);
  });

  it("gives the same candidate the same id across observations of one state", async () => {
    analyze.mockResolvedValue(readyAnalysis());

    const first = await observeCandidates({ wallet, config, tasks: [buyTask] });
    const second = await observeCandidates({
      wallet,
      config,
      tasks: [buyTask],
    });

    expect(first.candidates[0]!.candidateId).toBe(
      second.candidates[0]!.candidateId,
    );
  });

  it("changes every candidate id when the observed state moves", async () => {
    analyze.mockResolvedValue(readyAnalysis());
    const before = await observeCandidates({
      wallet,
      config,
      tasks: [buyTask],
    });

    getBlockNumber.mockResolvedValue(101n);
    readBalances.mockResolvedValue({
      ETH: ONE_ETH,
      USDC: 1n,
      UP: 0n,
      DG: 0n,
    });
    const after = await observeCandidates({ wallet, config, tasks: [buyTask] });

    // The id binds to the state it was derived from, which is what makes a
    // stale selection detectable rather than silently executed.
    expect(after.candidates[0]!.candidateId).not.toBe(
      before.candidates[0]!.candidateId,
    );
    expect(after.stateVersion).not.toBe(before.stateVersion);
  });

  it("deduplicates identical candidates from two tasks", async () => {
    analyze.mockResolvedValue(analysisWithDeficit("500"));

    const observation = await observeCandidates({
      wallet,
      config,
      tasks: [buyTask, { ...buyTask, id: "t-buy" }],
    });

    const ids = observation.candidates.map((c) => c.candidateId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ranks quest tasks ahead of preparation work", async () => {
    analyze.mockImplementation(async (_ctx: unknown, _input: unknown) =>
      analysisWithDeficit("500"),
    );
    const swap = actionByName("p2e_uniswap_swap")!;
    jest.spyOn(swap, "analyze").mockResolvedValue(readyAnalysis() as never);

    const observation = await observeCandidates({
      wallet,
      config,
      tasks: [buyTask],
    });

    const ranks = observation.candidates.map((c) => c.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe("executeCandidate", () => {
  function candidate(
    overrides: Partial<ActionCandidate> = {},
  ): ActionCandidate {
    return {
      candidateId: `cand_${"a".repeat(32)}`,
      actionName: "p2e_uniswap_swap",
      actionVersion: 2,
      purpose: { kind: "quest_task", taskId: "t1" },
      input: {
        pair: "ETH_UP",
        direction: "A_TO_B",
        amountInRaw: "1000",
      },
      analysis: readyAnalysis(),
      stateVersion: "s1",
      estimatedCostUsd: null,
      usefulEffects: 1,
      rank: 1,
      explanation: "go",
      expiresAt: null,
      ...overrides,
    } as ActionCandidate;
  }

  it("executes a candidate whose state still matches", async () => {
    execute.mockResolvedValue({
      status: "confirmed",
      txHash: `0x${"11".repeat(32)}`,
      approvals: [],
      blockNumber: "1",
    });

    const result = await executeCandidate({
      candidate: candidate(),
      expectedStateVersion: "s1",
      wallet,
      config,
    });

    expect(result.status).toBe("confirmed");
  });

  it("does not downgrade a failed transaction checkpoint into a retryable action result", async () => {
    execute.mockImplementation(async (context: ActionContext) => {
      await context.onTransactionPrepared?.({ approvals: [] });
      return {
        status: "confirmed",
        txHash: `0x${"11".repeat(32)}`,
        approvals: [],
        blockNumber: "1",
      };
    });

    await expect(
      executeCandidate({
        candidate: candidate(),
        expectedStateVersion: "s1",
        wallet,
        config,
        onTransactionPrepared: async () => {
          throw new Error("checkpoint unavailable");
        },
      }),
    ).rejects.toThrow("checkpoint unavailable");
  });

  it("refuses a candidate derived from older state", async () => {
    const result = await executeCandidate({
      candidate: candidate(),
      expectedStateVersion: "s2",
      wallet,
      config,
    });

    // Acting on a stale quote is the exact risk the state version exists for.
    expect(result).toMatchObject({
      status: "state_changed",
      code: "STALE_CANDIDATE",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a candidate whose quote has expired", async () => {
    const result = await executeCandidate({
      candidate: candidate({
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
      expectedStateVersion: "s1",
      wallet,
      config,
    });

    expect(result).toMatchObject({
      status: "state_changed",
      code: "QUOTE_EXPIRED",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a candidate built for a different version of the action", async () => {
    const result = await executeCandidate({
      candidate: candidate({ actionVersion: 1 }),
      expectedStateVersion: "s1",
      wallet,
      config,
    });

    expect(result).toMatchObject({
      status: "fatal_error",
      code: "ACTION_VERSION_UNAVAILABLE",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses an action name that does not exist", async () => {
    const result = await executeCandidate({
      candidate: candidate({ actionName: "p2e_transfer_anywhere" }),
      expectedStateVersion: "s1",
      wallet,
      config,
    });

    expect(result).toMatchObject({ status: "fatal_error" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an input the action's own schema does not accept", async () => {
    await expect(
      executeCandidate({
        candidate: candidate({
          input: {
            to: "0x000000000000000000000000000000000000dead",
            amountInRaw: "1",
          },
        }),
        expectedStateVersion: "s1",
        wallet,
        config,
      }),
    ).rejects.toThrow();

    // An arbitrary recipient never reaches the wallet.
    expect(execute).not.toHaveBeenCalled();
  });
});

it("retains the submitted hash when receipt confirmation times out", async () => {
  const action = actionByName("p2e_uniswap_swap")!;
  jest.spyOn(action, "analyze").mockResolvedValue(readyAnalysis() as never);
  jest.spyOn(action, "execute").mockImplementation(async (ctx) => {
    await ctx.onTransactionSubmitted?.({
      txHash: `0x${"11".repeat(32)}`,
      approvals: [],
    });
    throw new Error("Timed out while waiting for transaction receipt");
  });
  const submitted = jest.fn();
  const result = await executeCandidate({
    candidate: {
      candidateId: `cand_${"a".repeat(32)}`,
      actionName: "p2e_uniswap_swap",
      actionVersion: 2,
      purpose: { kind: "quest_task", taskId: "t1" },
      input: { pair: "ETH_UP", direction: "A_TO_B", amountInRaw: "1000" },
      analysis: readyAnalysis(),
      stateVersion: "s1",
      estimatedCostUsd: null,
      usefulEffects: 1,
      rank: 1,
      explanation: "audit",
      expiresAt: null,
    } as ActionCandidate,
    expectedStateVersion: "s1",
    wallet,
    config,
    onTransactionSubmitted: submitted,
  });
  expect(submitted).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    status: "submitted",
    txHash: `0x${"11".repeat(32)}`,
  });
});
