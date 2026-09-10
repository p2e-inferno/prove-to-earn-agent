/**
 * @jest-environment node
 */

const call = jest.fn();
const fetchAgentHistory = jest.fn();
const observeCandidates = jest.fn();
const executeCandidate = jest.fn();
const chatCompletion = jest.fn();

jest.mock("@/lib/ai/client", () => ({
  chatCompletion: (...args: unknown[]) => chatCompletion(...args),
}));

jest.mock("./session", () => ({
  AgentSession: class {
    call(...args: unknown[]) {
      return call(...args);
    }
  },
}));

jest.mock("./graph", () => ({
  fetchAgentHistory: (...args: unknown[]) => fetchAgentHistory(...args),
  summarizeHistory: jest.requireActual("./graph").summarizeHistory,
}));

// The candidate layer owns chain access; this suite is about what the run does
// with its results, so it is driven rather than simulated.
jest.mock("./candidates", () => ({
  observeCandidates: (...args: unknown[]) => observeCandidates(...args),
  executeCandidate: (...args: unknown[]) => executeCandidate(...args),
}));

jest.mock("./brain", () => ({
  narrateRun: async () => ({
    headline: "h",
    summary: "s",
    nextSteps: [],
    source: "deterministic",
  }),
}));

jest.mock("@ethereum-attestation-service/eas-sdk", () => ({ EAS: class {} }));

import { runDailyQuest } from "./run";
import type { AgentWallet } from "./wallet";
import type { RunnerConfig } from "./config";
import type { ActionCandidate } from "./actions/types";
import { actionByName } from "./actions/registry";

const waitForReceipt = jest.fn();
const getTransactionReceipt = jest.fn();

const wallet = {
  address: "0xagent",
  provider: "local",
  waitForReceipt: (...args: unknown[]) => waitForReceipt(...args),
  publicClient: {
    getTransactionReceipt: (...args: unknown[]) =>
      getTransactionReceipt(...args),
  },
} as unknown as AgentWallet;

const config = {
  gatewayBaseUrl: "https://gw.test",
  chainId: 8453,
} as unknown as RunnerConfig;

const HASH = `0x${"11".repeat(32)}`;

const okResult = <T>(data: T) => ({
  status: 200,
  ok: true,
  data,
  paid: true,
  discounted: false,
});

const errResult = (code: string, status = 400) => ({
  status,
  ok: false,
  code,
  message: code,
  paid: false,
  discounted: false,
});

const swapTask = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: `Swap ${id}`,
  task_type: "uniswap_swap",
  task_config: {
    pair: "ETH_UP",
    direction: "A_TO_B",
    required_amount_in: "1000",
    ...overrides,
  },
});

const candidateFor = (taskId: string): ActionCandidate =>
  ({
    candidateId: `cand_${taskId
      .replace(/[^a-f0-9]/g, "a")
      .padEnd(32, "0")
      .slice(0, 32)}`,
    actionName: "p2e_uniswap_swap",
    actionVersion: 2,
    purpose: { kind: "quest_task", taskId },
    input: {},
    analysis: {
      executableNow: true,
      requirements: [],
      effects: [],
      blockers: [],
      gasEstimateRaw: null,
      quote: {
        source: "rpc",
        blockNumber: "1",
        observedAt: new Date().toISOString(),
        expiresAt: null,
      },
    },
    stateVersion: "s1",
    estimatedCostUsd: null,
    usefulEffects: 1,
    rank: 1,
    explanation: "go",
    expiresAt: null,
  }) as ActionCandidate;

function listWith(tasks: unknown[]) {
  return okResult({
    runs: [
      {
        id: "run-1",
        eligibility: { eligible: true },
        template: { title: "Daily" },
        daily_quest_run_tasks: tasks,
      },
    ],
  });
}

/** Routes each gateway path to a queued response, so order is not assumed. */
function route(handlers: Record<string, () => unknown>) {
  call.mockImplementation(async (path: string) => {
    if (path.endsWith("/quests/run-1")) {
      return handlers["/quests/run-1"]?.() ?? okResult({ completions: [] });
    }
    const key = Object.keys(handlers).find((k) => path.includes(k));
    if (!key) throw new Error(`Unrouted gateway call: ${path}`);
    return handlers[key]!();
  });
}

const published = () =>
  call.mock.calls.filter(([path]) => String(path).includes("/reports"));

/**
 * Drive the planner as a model would: observe, then execute whatever the
 * current observation offers first, until nothing is left.
 */
function modelPicksEveryCandidate() {
  process.env.OPENROUTER_API_KEY = "test-key";
  let seen: string[] = [];
  let turn = 0;
  chatCompletion.mockImplementation(async () => {
    turn += 1;
    if (turn % 2 === 1) {
      return {
        success: true,
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: `c${turn}`,
            function: { name: "observe_run", arguments: "{}" },
          },
        ],
        assistantMessage: { role: "assistant", content: null, tool_calls: [] },
      };
    }
    const next = seen.shift();
    if (!next) return { success: true, finishReason: "stop", content: "done" };
    return {
      success: true,
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: `c${turn}`,
          function: {
            name: "execute_candidate",
            arguments: JSON.stringify({ candidateId: next }),
          },
        },
      ],
      assistantMessage: { role: "assistant", content: null, tool_calls: [] },
    };
  });
  observeCandidates.mockImplementation(
    async (args: {
      settledTaskIds?: Set<string>;
      tasks: Array<{ id: string }>;
    }) => {
      const candidates = args.tasks
        .filter((task) => !args.settledTaskIds?.has(task.id))
        .map((task) => candidateFor(task.id));
      seen = candidates.map((candidate) => candidate.candidateId);
      return {
        stateVersion: "s1",
        blockNumber: "1",
        balances: [],
        candidates,
        ownerBlockers: [],
        fatalBlockers: [],
      };
    },
  );
}

/** Offer one candidate per unsettled task, the way the real observer does. */
function offerCandidatesFor(taskIds: string[]) {
  observeCandidates.mockImplementation(
    async (args: { settledTaskIds?: Set<string> }) => ({
      stateVersion: "s1",
      blockNumber: "1",
      balances: [],
      candidates: taskIds
        .filter((id) => !args.settledTaskIds?.has(id))
        .map(candidateFor),
      ownerBlockers: [],
      fatalBlockers: [],
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.OPENROUTER_API_KEY;
  fetchAgentHistory.mockResolvedValue({
    swaps: [],
    vendorEvents: [],
    vendorTotals: null,
  });
  waitForReceipt.mockResolvedValue({ status: "success" });
  getTransactionReceipt.mockResolvedValue({ status: "success" });
  offerCandidatesFor([]);
  executeCandidate.mockResolvedValue({
    status: "confirmed",
    txHash: HASH,
    approvals: [],
    blockNumber: "1",
  });
});

describe("runDailyQuest", () => {
  it("does not start the quest or publish during a dry run", async () => {
    route({ "/quests": () => listWith([swapTask("t1")]) });

    const report = await runDailyQuest(wallet, config, { dryRun: true });

    expect(report.blockingCode).toBe("DRY_RUN");
    expect(executeCandidate).not.toHaveBeenCalled();
    expect(
      call.mock.calls.some(([path]) => String(path).includes("/start")),
    ).toBe(false);
    expect(published()).toHaveLength(0);
  });

  it("credits a confirmed checkpoint transaction without re-executing it", async () => {
    offerCandidatesFor(["t1"]);
    route({
      "/quests/run-1/start": () => okResult({}),
      "/tasks/complete": () => okResult({ completionId: "c1" }),
      "/intent": () => errResult("EAS_DISABLED"),
      "/tasks/claim": () => okResult({ rewardAmount: 5 }),
      "/quests/run-1/complete": () => okResult({}),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1")]),
    });

    const report = await runDailyQuest(wallet, config, {
      restoredTimeline: [
        {
          candidateId: `cand_${"a".repeat(32)}`,
          actionName: "p2e_uniswap_swap",
          purpose: "quest_task",
          taskId: "t1",
          status: "submitted",
          txHash: HASH,
        },
      ],
    });

    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: HASH });
    expect(executeCandidate).not.toHaveBeenCalled();
    expect(report.tasks[0]?.status).toBe("claimed");
    expect(report.questCompleted).toBe(true);
  });

  it("waits for a pending checkpoint transaction instead of replacing it", async () => {
    getTransactionReceipt.mockRejectedValue(new Error("receipt not found"));
    route({
      "/quests/run-1/start": () => okResult({}),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1")]),
    });

    const report = await runDailyQuest(wallet, config, {
      restoredTimeline: [
        {
          actionName: "p2e_uniswap_swap",
          purpose: "quest_task",
          taskId: "t1",
          status: "submitted",
          txHash: HASH,
        },
      ],
    });

    expect(report.blockingCode).toBe("TX_CONFIRMATION_PENDING");
    expect(executeCandidate).not.toHaveBeenCalled();
  });

  it("requires owner reconciliation when a broadcast may lack a recorded hash", async () => {
    route({
      "/quests/run-1/start": () => okResult({}),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1")]),
    });

    const report = await runDailyQuest(wallet, config, {
      restoredTimeline: [
        {
          actionName: "p2e_uniswap_swap",
          purpose: "quest_task",
          taskId: "t1",
          status: "broadcasting",
        },
      ],
    });

    expect(report.blockingCode).toBe(
      "OWNER_TRANSACTION_RECONCILIATION_REQUIRED",
    );
    expect(report.ownerQuestions?.[0]?.blockedTaskId).toBe("t1");
    expect(getTransactionReceipt).not.toHaveBeenCalled();
    expect(executeCandidate).not.toHaveBeenCalled();
  });

  it("reports and stops when the quest list cannot be read", async () => {
    route({ "/quests": () => errResult("GATEWAY_UNREACHABLE", 0) });

    const report = await runDailyQuest(wallet, config, {});

    expect(report.succeeded).toBe(false);
    expect(report.blockingCode).toBe("GATEWAY_UNREACHABLE");
    expect(executeCandidate).not.toHaveBeenCalled();
  });

  it("does not act when the owner is already on a different quest path", async () => {
    offerCandidatesFor(["t1"]);
    route({
      "/quests/run-1/start": () =>
        errResult("DAILY_QUEST_PATH_ALREADY_SELECTED", 409),
      "/quests": () => listWith([swapTask("t1")]),
      "/reports": () => okResult({}),
    });

    const report = await runDailyQuest(wallet, config, {});

    // Spending gas on a run the owner is not on is the failure this guards.
    expect(executeCandidate).not.toHaveBeenCalled();
    expect(report.succeeded).toBe(false);
    expect(report.blockingCode).toBe("DAILY_QUEST_PATH_ALREADY_SELECTED");
  });

  it("executes at most one state-changing candidate per cycle", async () => {
    modelPicksEveryCandidate();
    let claimed = 0;
    route({
      "/quests/run-1/start": () => okResult({}),
      "/quests/run-1/complete": () => okResult({ transactionHash: "0xkey" }),
      "/tasks/complete": () => okResult({ completionId: `c${++claimed}` }),
      "/intent": () => errResult("EAS_DISABLED"),
      "/tasks/claim": () => okResult({ rewardAmount: 5 }),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1"), swapTask("t2")]),
    });

    const report = await runDailyQuest(wallet, config, {});

    expect(executeCandidate).toHaveBeenCalledTimes(1);
    expect(report.tasks.map((t) => t.status)).toEqual(["claimed", "skipped"]);
    expect(report.questCompleted).toBe(false);
    expect(report.blockingCode).toBe("CYCLE_BOUND_REACHED");
    expect(report.succeeded).toBe(false);
  });

  it("does not redo a task the server already recorded as done", async () => {
    offerCandidatesFor(["t1", "t2"]);
    route({
      "/quests/run-1/start": () => okResult({}),
      "/quests/run-1/complete": () => okResult({ transactionHash: "0xkey" }),
      "/quests/run-1": () =>
        okResult({
          completions: [
            {
              id: "c1",
              daily_quest_run_task_id: "t1",
              submission_status: "completed",
              reward_claimed: true,
            },
          ],
        }),
      "/tasks/complete": () => okResult({ completionId: "c2" }),
      "/intent": () => errResult("EAS_DISABLED"),
      "/tasks/claim": () => okResult({ rewardAmount: 5 }),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1"), swapTask("t2")]),
    });

    const report = await runDailyQuest(wallet, config, {});

    // t1 landed on an earlier attempt. Sending it again would buy twice and
    // pay once, which is what a restart used to do.
    expect(executeCandidate).toHaveBeenCalledTimes(1);
    expect(
      (executeCandidate.mock.calls[0]![0] as { candidate: ActionCandidate })
        .candidate.purpose,
    ).toMatchObject({ taskId: "t2" });
    const byId = Object.fromEntries(report.tasks.map((t) => [t.taskId, t]));
    expect(byId.t1).toMatchObject({ status: "claimed" });
    expect(byId.t2).toMatchObject({ status: "claimed" });
  });

  it("recovers an unpaid reward without redoing the work", async () => {
    route({
      "/quests/run-1/start": () => okResult({}),
      "/quests/run-1/complete": () => okResult({ transactionHash: "0xkey" }),
      "/quests/run-1": () =>
        okResult({
          completions: [
            {
              id: "c1",
              daily_quest_run_task_id: "t1",
              submission_status: "completed",
              reward_claimed: false,
            },
          ],
        }),
      "/intent": () => errResult("EAS_DISABLED"),
      "/tasks/claim": () => okResult({ rewardAmount: 7 }),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1")]),
    });

    const report = await runDailyQuest(wallet, config, {});

    // Verified already; only the claim was outstanding, and it needs no
    // transaction. '/tasks/complete' is deliberately unrouted here.
    expect(executeCandidate).not.toHaveBeenCalled();
    expect(report.tasks).toHaveLength(1);
    expect(report.tasks[0]).toMatchObject({
      status: "claimed",
      rewardAmount: 7,
    });
    expect(report.questCompleted).toBe(true);
  });

  it("refuses to act when it cannot read what already settled", async () => {
    offerCandidatesFor(["t1"]);
    route({
      "/quests/run-1/start": () => okResult({}),
      "/quests/run-1": () => errResult("GATEWAY_UNREACHABLE", 0),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1")]),
    });

    const report = await runDailyQuest(wallet, config, {});

    // Acting blind is the one failure that spends the owner's money twice.
    expect(executeCandidate).not.toHaveBeenCalled();
    expect(report.blockingCode).toBe("GATEWAY_UNREACHABLE");
  });

  it("asks the owner rather than retrying a task only they can do", async () => {
    offerCandidatesFor([]);
    route({
      "/quests/run-1/start": () => okResult({}),
      "/quests/run-1": () => okResult({ completions: [] }),
      "/reports": () => okResult({}),
      "/quests": () =>
        listWith([
          { id: "t0", title: "Upload proof", task_type: "proof_upload" },
          swapTask("t1"),
        ]),
    });

    const report = await runDailyQuest(wallet, config, {});

    // Left uncoded this reads as a transient fault, and the worker then
    // retries a run that can never finish on its own.
    expect(report.blockingCode).toBe("OWNER_ACTION_REQUIRED");
  });

  it("records an unsupported task type and keeps going", async () => {
    offerCandidatesFor(["t1"]);
    route({
      "/quests/run-1/start": () => okResult({}),
      "/tasks/complete": () => okResult({ completionId: "c1" }),
      "/intent": () => errResult("EAS_DISABLED"),
      "/tasks/claim": () => okResult({ rewardAmount: 5 }),
      "/reports": () => okResult({}),
      "/quests": () =>
        listWith([
          { id: "t0", title: "Upload proof", task_type: "proof_upload" },
          swapTask("t1"),
        ]),
    });

    const report = await runDailyQuest(wallet, config, {});

    const byId = Object.fromEntries(report.tasks.map((t) => [t.taskId, t]));
    expect(byId.t0).toMatchObject({ status: "skipped" });
    expect(byId.t1).toMatchObject({ status: "claimed" });
    // One task was not done, so the key must not be granted.
    expect(report.questCompleted).toBe(false);
  });

  it("refuses a misconfigured task instead of guessing what to swap", async () => {
    route({
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1", { pair: "DOGE_MOON" })]),
    });

    const report = await runDailyQuest(wallet, config, {});

    expect(executeCandidate).not.toHaveBeenCalled();
    expect(report.tasks[0]).toMatchObject({
      status: "skipped",
      code: "INVALID_TASK_CONFIG",
    });
  });

  it("refuses a zero-amount task", async () => {
    route({
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1", { required_amount_in: "0" })]),
    });

    const report = await runDailyQuest(wallet, config, {});

    expect(executeCandidate).not.toHaveBeenCalled();
    expect(report.tasks[0]?.code).toBe("INVALID_TASK_CONFIG");
  });

  it("records what The Graph says the agent has already done", async () => {
    offerCandidatesFor(["t1"]);
    fetchAgentHistory.mockResolvedValue({
      swaps: [{ id: "s1" }],
      vendorEvents: [{ id: "v1" }],
      vendorTotals: {
        stage: 2,
        totalBought: "1",
        totalSold: "0",
        lightUpCount: 1,
      },
    });
    route({
      "/quests/run-1/start": () => okResult({}),
      "/tasks/complete": () => okResult({ completionId: "c1" }),
      "/intent": () => errResult("EAS_DISABLED"),
      "/tasks/claim": () => okResult({ rewardAmount: 5 }),
      "/quests/run-1/complete": () => okResult({}),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1")]),
    });

    const report = await runDailyQuest(wallet, config, {});

    expect(report.historyNote).toContain("recent swap");
    expect(report.historyNote).toContain("vendor stage 2");
  });

  it("still runs when its on-chain memory cannot be read", async () => {
    offerCandidatesFor(["t1"]);
    fetchAgentHistory.mockRejectedValue(new Error("graph down"));
    route({
      "/quests/run-1/start": () => okResult({}),
      "/tasks/complete": () => okResult({ completionId: "c1" }),
      "/intent": () => errResult("EAS_DISABLED"),
      "/tasks/claim": () => okResult({ rewardAmount: 5 }),
      "/quests/run-1/complete": () => okResult({}),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1")]),
    });

    const report = await runDailyQuest(wallet, config, {});

    expect(report.historyNote).toBeUndefined();
    expect(report.tasks[0]?.status).toBe("claimed");
  });

  it("reports a verified task whose reward did not land as reward_pending", async () => {
    offerCandidatesFor(["t1"]);
    route({
      "/quests/run-1/start": () => okResult({}),
      "/tasks/complete": () => okResult({ completionId: "c1" }),
      "/intent": () => errResult("EAS_DISABLED"),
      "/tasks/claim": () => errResult("ATTESTATION_UNRESOLVED", 409),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1")]),
    });

    const report = await runDailyQuest(wallet, config, {});

    // Credited on-chain but unpaid: calling that a success tells the owner
    // they were paid when they were not.
    expect(report.tasks[0]).toMatchObject({
      status: "reward_pending",
      code: "ATTESTATION_UNRESOLVED",
      txHash: HASH,
    });
    expect(report.succeeded).toBe(false);
  });

  it("marks a candidate the chain rejected without claiming", async () => {
    offerCandidatesFor(["t1"]);
    executeCandidate.mockResolvedValue({
      status: "state_changed",
      code: "TX_REVERTED",
      message: "The swap reverted; observe current state before retrying.",
    });
    route({
      "/quests/run-1/start": () => okResult({}),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1")]),
    });

    const report = await runDailyQuest(wallet, config, {});

    const completes = call.mock.calls.filter(([p]) =>
      String(p).includes("/tasks/complete"),
    );
    expect(completes).toHaveLength(0);
    expect(report.tasks[0]).toMatchObject({ status: "skipped" });
    expect(report.succeeded).toBe(false);
  });

  it("does not submit a prerequisite as a task completion", async () => {
    const prerequisite = {
      ...candidateFor("t1"),
      candidateId: `cand_${"b".repeat(32)}`,
      purpose: {
        kind: "prerequisite" as const,
        forTaskId: "t1",
        resolves: [
          { kind: "asset" as const, asset: "UP" as const, requiredRaw: "10" },
        ],
      },
    } as ActionCandidate;
    observeCandidates.mockResolvedValue({
      stateVersion: "s1",
      blockNumber: "1",
      balances: [],
      candidates: [prerequisite],
      ownerBlockers: [],
      fatalBlockers: [],
    });
    route({
      "/quests/run-1/start": () => okResult({}),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1")]),
    });

    const report = await runDailyQuest(wallet, config, {});

    // The swap funded the task; submitting it would credit the task with a
    // hash that does not satisfy the verifier's own requirements.
    expect(
      call.mock.calls.filter(([p]) => String(p).includes("/tasks/complete")),
    ).toHaveLength(0);
    expect(report.actionTimeline).toEqual([
      expect.objectContaining({ purpose: "prerequisite", taskId: "t1" }),
    ]);
  });

  it("stops when the configured funding-swap budget is exhausted", async () => {
    const prerequisite = {
      ...candidateFor("t1"),
      candidateId: `cand_${"b".repeat(32)}`,
      purpose: {
        kind: "prerequisite" as const,
        forTaskId: "t1",
        resolves: [
          {
            kind: "asset" as const,
            asset: "UP" as const,
            requiredRaw: "10",
            deficitRaw: "10",
          },
        ],
      },
    } as ActionCandidate;
    observeCandidates.mockResolvedValue({
      stateVersion: "s1",
      blockNumber: "1",
      balances: [],
      candidates: [prerequisite],
      ownerBlockers: [],
      fatalBlockers: [],
    });
    route({
      "/quests/run-1/start": () => okResult({}),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1")]),
    });

    const report = await runDailyQuest(
      wallet,
      { ...config, maxFundingSwaps: 1 },
      {
        restoredTimeline: [
          {
            actionName: "p2e_uniswap_swap",
            purpose: "prerequisite",
            taskId: "t1",
            status: "confirmed",
            txHash: HASH,
          },
        ],
      },
    );

    expect(executeCandidate).not.toHaveBeenCalled();
    expect(report.blockingCode).toBe("FUNDING_SWAP_LIMIT");
  });

  it("records every executed action in the timeline, quest and prerequisite alike", async () => {
    offerCandidatesFor(["t1"]);
    route({
      "/quests/run-1/start": () => okResult({}),
      "/tasks/complete": () => okResult({ completionId: "c1" }),
      "/intent": () => errResult("EAS_DISABLED"),
      "/tasks/claim": () => okResult({ rewardAmount: 5 }),
      "/quests/run-1/complete": () => okResult({}),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1")]),
    });

    const report = await runDailyQuest(wallet, config, {});

    expect(report.actionTimeline).toEqual([
      expect.objectContaining({
        actionName: "p2e_uniswap_swap",
        purpose: "quest_task",
        taskId: "t1",
        status: "confirmed",
        txHash: HASH,
      }),
    ]);
  });

  it("checkpoints intent before broadcast and the hash before confirmation", async () => {
    offerCandidatesFor(["t1"]);
    executeCandidate.mockImplementation(
      async (args: {
        onTransactionPrepared?: (value: { approvals: [] }) => Promise<void>;
        onTransactionSubmitted?: (value: {
          txHash: `0x${string}`;
          approvals: [];
        }) => Promise<void>;
      }) => {
        await args.onTransactionPrepared?.({ approvals: [] });
        await args.onTransactionSubmitted?.({
          txHash: HASH as `0x${string}`,
          approvals: [],
        });
        return {
          status: "confirmed",
          txHash: HASH,
          approvals: [],
          blockNumber: "1",
        };
      },
    );
    route({
      "/quests/run-1/start": () => okResult({}),
      "/tasks/complete": () => okResult({ completionId: "c1" }),
      "/intent": () => errResult("EAS_DISABLED"),
      "/tasks/claim": () => okResult({ rewardAmount: 5 }),
      "/quests/run-1/complete": () => okResult({}),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1")]),
    });
    const states: string[] = [];

    await runDailyQuest(wallet, config, {
      onProgress: async ({ actionTimeline }) => {
        states.push(actionTimeline[0]?.status ?? "empty");
      },
    });

    expect(states).toEqual(
      expect.arrayContaining(["broadcasting", "submitted", "confirmed"]),
    );
    expect(states.indexOf("broadcasting")).toBeLessThan(
      states.indexOf("submitted"),
    );
  });

  it("does not guess an execution order when more than one candidate is safe", async () => {
    offerCandidatesFor(["t1", "t2"]);
    const swap = actionByName("p2e_uniswap_swap")!;
    const execute = jest.spyOn(swap, "execute" as never).mockResolvedValue({
      status: "confirmed",
      txHash: HASH,
      approvals: [],
      blockNumber: "1",
    } as never);
    let claimed = 0;
    route({
      "/quests/run-1/start": () => okResult({}),
      "/quests/run-1/complete": () => okResult({ transactionHash: "0xkey" }),
      "/tasks/complete": () => okResult({ completionId: `c${++claimed}` }),
      "/intent": () => errResult("EAS_DISABLED"),
      "/tasks/claim": () => okResult({ rewardAmount: 5 }),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1"), swapTask("t2")]),
    });

    const report = await runDailyQuest(wallet, config, {});

    expect(executeCandidate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(report.tasks.map((t) => t.taskId).sort()).toEqual(["t1", "t2"]);
    expect(report.questCompleted).toBe(false);
    expect(report.blockingCode).toBe("PLANNER_SELECTION_REQUIRED");
    execute.mockRestore();
  });

  it("publishes a report even when the run never reached a task", async () => {
    route({
      "/reports": () => okResult({}),
      "/quests": () => okResult({ runs: [] }),
    });

    const report = await runDailyQuest(wallet, config, {});

    expect(published()).toHaveLength(1);
    expect(report.blockingReason).toContain("No daily quest runs");
  });

  it("refuses an explicit run that is not open, rather than running another", async () => {
    route({
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1")]),
    });

    const report = await runDailyQuest(wallet, config, { runId: "run-other" });

    expect(report.blockingCode).toBe("RUN_NOT_FOUND");
    expect(
      call.mock.calls.filter(([p]) => String(p).includes("/start")),
    ).toHaveLength(0);
  });

  it("does not enter a run when no task in it can be executed", async () => {
    route({
      "/reports": () => okResult({}),
      "/quests": () =>
        listWith([{ id: "t0", title: "Upload", task_type: "proof_upload" }]),
    });

    const report = await runDailyQuest(wallet, config, {});

    // Starting binds the owner to this path for the day, so entering one the
    // agent cannot finish costs them the run they could have done by hand.
    expect(
      call.mock.calls.filter(([p]) => String(p).includes("/start")),
    ).toHaveLength(0);
    expect(report.blockingCode).toBe("NOTHING_EXECUTABLE");
  });

  it("does not consume a quest path when one task is executable but another needs owner funding", async () => {
    observeCandidates.mockResolvedValue({
      stateVersion: "s1",
      blockNumber: "1",
      balances: [
        {
          asset: "USDC",
          tokenAddress: "0x0000000000000000000000000000000000000001",
          decimals: 6,
          raw: "1000000",
          formatted: "1",
        },
      ],
      candidates: [candidateFor("t1")],
      ownerBlockers: [
        {
          taskId: "t2",
          code: "OWNER_PREREQUISITE_UNAVAILABLE",
          message: "The second task cannot be funded safely.",
          deficits: [
            {
              asset: "USDC",
              tokenAddress: "0x0000000000000000000000000000000000000001",
              decimals: 6,
              raw: "2000000",
              formatted: "2",
            },
          ],
        },
      ],
      fatalBlockers: [],
    });
    route({
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1"), swapTask("t2")]),
    });

    const result = await runDailyQuest(wallet, config, {});

    expect(
      call.mock.calls.filter(([path]) => String(path).includes("/start")),
    ).toHaveLength(0);
    expect(executeCandidate).not.toHaveBeenCalled();
    expect(result.blockingReason).toContain("Exact shortfall: USDC 2");
    expect(result.blockingReason).toContain("Fund 0xagent");
  });

  it("sends a stable idempotency key per effect", async () => {
    offerCandidatesFor(["t1"]);
    route({
      "/quests/run-1/start": () => okResult({}),
      "/tasks/complete": () => okResult({ completionId: "c1" }),
      "/intent": () => errResult("EAS_DISABLED"),
      "/tasks/claim": () => okResult({ rewardAmount: 5 }),
      "/quests/run-1/complete": () => okResult({}),
      "/reports": () => okResult({}),
      "/quests": () => listWith([swapTask("t1")]),
    });

    await runDailyQuest(wallet, config, {});

    const start = call.mock.calls.find(([p]) =>
      String(p).includes("/start"),
    )?.[1];
    expect(start.idempotencyKey).toBe("start:run-1:0xagent");

    const complete = call.mock.calls.find(([p]) =>
      String(p).includes("/tasks/complete"),
    )?.[1];
    // Keyed on the hash so a retry settles the original rather than re-running.
    expect(complete.idempotencyKey).toBe(`complete:${HASH}`);
  });
});

it("reconciles a pending transaction before checking funding again", async () => {
  route({
    "/quests": () => listWith([swapTask("t1")]),
    "/reports": () => okResult({}),
  });
  getTransactionReceipt.mockRejectedValueOnce(
    new Error("Receipt not available"),
  );
  observeCandidates.mockResolvedValue({
    stateVersion: "v",
    blockNumber: "1",
    balances: [],
    candidates: [],
    fatalBlockers: [],
    ownerBlockers: [
      {
        taskId: "t1",
        code: "INSUFFICIENT_ETH",
        message: "Spent on pending transaction",
      },
    ],
  });
  const result = await runDailyQuest(wallet, config, {
    runId: "run-1",
    restoredTimeline: [
      {
        candidateId: "candidate",
        actionName: "p2e_uniswap_swap",
        purpose: "quest_task",
        taskId: "t1",
        status: "submitted",
        txHash: HASH,
      },
    ],
  });
  expect(result.blockingCode).toBe("TX_CONFIRMATION_PENDING");
  expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: HASH });
  expect(observeCandidates).not.toHaveBeenCalled();
  expect(executeCandidate).not.toHaveBeenCalled();
});
