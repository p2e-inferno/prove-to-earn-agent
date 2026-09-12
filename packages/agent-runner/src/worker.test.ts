/**
 * @jest-environment node
 */

const call = jest.fn();
const runDailyQuest = jest.fn();
const assertAgentNetwork = jest.fn();
const executionMode = jest.fn();

jest.mock("./session", () => ({
  AgentSession: class {
    call(...args: unknown[]) {
      return call(...args);
    }
    executionMode() {
      return executionMode();
    }
  },
}));

jest.mock("./run", () => ({
  runDailyQuest: (...args: unknown[]) => runDailyQuest(...args),
}));

jest.mock("./network", () => ({
  assertAgentNetwork: (...args: unknown[]) => assertAgentNetwork(...args),
}));

import { AgentWorker, classifyFailure, retryDelayMs } from "./worker";
import type { AgentWallet } from "./wallet";
import type { RunnerConfig } from "./config";

const wallet = {
  address: "0xagent",
  provider: "local",
} as unknown as AgentWallet;

const config = {
  gatewayBaseUrl: "https://gw.test",
  chainId: 8453,
  pollIntervalMs: 30_000,
  leaseRenewMs: 40_000,
} as unknown as RunnerConfig;

const EXEC = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";

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

const acquired = (overrides: Record<string, unknown> = {}) =>
  okResult({
    execution: {
      outcome: "acquired",
      execution_id: EXEC,
      attempt_token: TOKEN,
      state_version: 0,
      status: "planning",
      checkpoint: {},
      ...overrides,
    },
  });

const saved = () =>
  okResult({
    execution: { outcome: "saved", state_version: 1, status: "running" },
  });

const report = (overrides: Record<string, unknown> = {}) => ({
  runId: "run-1",
  questTitle: "Daily",
  agentAddress: "0xagent",
  walletProvider: "local",
  tasks: [
    { taskId: "t1", title: "t", taskType: "uniswap_swap", status: "claimed" },
  ],
  questCompleted: true,
  keyTxHash: "0xkey",
  totalPaidCalls: 1,
  discountedCalls: 0,
  succeeded: true,
  narrative: {
    headline: "h",
    summary: "s",
    nextSteps: [],
    source: "deterministic",
  },
  ...overrides,
});

/** Route gateway calls by path fragment, so call order is never assumed. */
function route(handlers: Record<string, (body?: unknown) => unknown>) {
  call.mockImplementation(
    async (path: string, options?: { body?: unknown }) => {
      const key = Object.keys(handlers).find((k) => path.includes(k));
      if (!key) throw new Error(`Unrouted gateway call: ${path}`);
      return handlers[key]!(options?.body);
    },
  );
}

const checkpoints = () =>
  call.mock.calls
    .filter(
      ([, options]) =>
        (options as { body?: { operation?: string } })?.body?.operation ===
        "checkpoint",
    )
    .map(([, options]) => (options as { body: Record<string, unknown> }).body);

const sleep = jest.fn().mockResolvedValue(undefined);

beforeEach(() => {
  jest.clearAllMocks();
  sleep.mockResolvedValue(undefined);
  assertAgentNetwork.mockResolvedValue([]);
  executionMode.mockResolvedValue("scheduled");
  runDailyQuest.mockResolvedValue(report());
});

function worker(overrides: Record<string, unknown> = {}) {
  return new AgentWorker(wallet, config, {
    runId: "run-1",
    sleep,
    now: () => 1_000_000,
    ...overrides,
  });
}

describe("classifyFailure", () => {
  it.each([
    ["GATEWAY_UNREACHABLE", "retryable"],
    ["IDEMPOTENCY_IN_FLIGHT", "retryable"],
    ["INSUFFICIENT_UP", "owner_required"],
    ["VENDOR_PAUSED", "time_dependent"],
    ["SELL_COOLDOWN", "time_dependent"],
    ["AGENT_WALLET_NOT_KEYHOLDER", "owner_required"],
    ["INSUFFICIENT_FUNDS", "owner_required"],
    ["UNSUPPORTED_ROUTE", "fatal"],
    ["INVALID_TASK_CONFIG", "fatal"],
    ["DAILY_QUEST_PATH_ALREADY_SELECTED", "fatal"],
    ["X402_PAYMENT_VALIDATION_FAILED", "fatal"],
  ])("routes %s to %s", (code, expected) => {
    expect(classifyFailure(code)).toBe(expected);
  });

  it("treats an unrecognised code as retryable rather than fatal", () => {
    // Abandoning recoverable work on an unknown code is the worse mistake.
    expect(classifyFailure("SOMETHING_NEW")).toBe("retryable");
  });
});

describe("retryDelayMs", () => {
  it("backs off exponentially from 30s and caps at 5 minutes", () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(120_000);
    expect(retryDelayMs(9)).toBe(300_000);
  });
});

describe("AgentWorker.preflight", () => {
  it("prevents the scheduled adapter from discovering owner-invoked agents", async () => {
    executionMode.mockResolvedValue("owner_invoked");

    await expect(
      worker({ requiredExecutionMode: "scheduled" }).preflight(),
    ).rejects.toThrow("owner_invoked, not scheduled");
  });
});

describe("AgentWorker.runOnce", () => {
  it("acquires a lease, runs, and checkpoints completion", async () => {
    route({
      "/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired()
          : saved(),
    });

    const cycle = await worker().runOnce("run-1");

    expect(cycle.outcome).toBe("ran");
    const final = checkpoints().at(-1)!;
    expect(final).toMatchObject({ status: "completed", releaseLease: true });
  });

  it("continues an intentional cycle boundary without failure backoff", async () => {
    runDailyQuest.mockResolvedValue(
      report({
        succeeded: false,
        questCompleted: false,
        blockingCode: "CYCLE_BOUND_REACHED",
        blockingReason: "One action was completed in this cycle.",
      }),
    );
    route({
      "/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired({ checkpoint: { attempts: 2 } })
          : saved(),
    });

    const cycle = await worker().runOnce("run-1");

    expect(cycle.outcome).toBe("continue");
    expect(checkpoints().at(-1)).toMatchObject({
      status: "waiting_retry",
      checkpoint: { attempts: 2 },
      nextRetryAt: new Date(1_000_000).toISOString(),
      lastError: null,
      releaseLease: true,
    });
  });

  it("yields to the worker that already holds the lease", async () => {
    route({ "/execution": () => errResult("EXECUTION_BUSY", 409) });

    const cycle = await worker().runOnce("run-1");

    // Two workers on one run would double-spend; the second must not run.
    expect(cycle.outcome).toBe("busy");
    expect(runDailyQuest).not.toHaveBeenCalled();
  });

  it("refuses a run that belongs to another owner", async () => {
    route({ "/execution": () => errResult("EXECUTION_FORBIDDEN", 403) });

    const cycle = await worker().runOnce("run-1");

    expect(cycle.outcome).toBe("forbidden");
    expect(runDailyQuest).not.toHaveBeenCalled();
  });

  it("does not re-run a run already in a terminal state", async () => {
    route({
      "/execution": () => okResult({ execution: { outcome: "terminal" } }),
    });

    const cycle = await worker().runOnce("run-1");

    expect(cycle.outcome).toBe("terminal");
    expect(runDailyQuest).not.toHaveBeenCalled();
  });

  it("retries a throwing run in-process before persisting the wait", async () => {
    runDailyQuest
      .mockRejectedValueOnce(new Error("rpc blip"))
      .mockResolvedValueOnce(report());
    route({
      "/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired()
          : saved(),
    });

    const cycle = await worker().runOnce("run-1");

    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(cycle.outcome).toBe("ran");
  });

  it("does not restore an intent whose pre-broadcast checkpoint failed", async () => {
    let checkpointCalls = 0;
    runDailyQuest
      .mockImplementationOnce(async (_wallet, _config, options) => {
        await options.onProgress({
          actionTimeline: [
            {
              actionName: "p2e_uniswap_swap",
              purpose: "quest_task",
              taskId: "t1",
              status: "broadcasting",
            },
          ],
        });
        return report();
      })
      .mockImplementationOnce(async (_wallet, _config, options) => {
        expect(options.restoredTimeline).toEqual([]);
        return report();
      });
    route({
      "/execution": (body) => {
        const operation = (body as { operation: string }).operation;
        if (operation === "acquire") return acquired();
        checkpointCalls += 1;
        return checkpointCalls === 1
          ? errResult("EXECUTION_CHECKPOINT_CONFLICT", 409)
          : saved();
      },
    });

    const cycle = await worker().runOnce("run-1");

    expect(cycle.outcome).toBe("ran");
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("retains a known hash in memory when its checkpoint fails", async () => {
    const submitted = {
      actionName: "p2e_uniswap_swap",
      purpose: "quest_task" as const,
      taskId: "t1",
      status: "submitted" as const,
      txHash: "0xhash",
    };
    let checkpointCalls = 0;
    runDailyQuest
      .mockImplementationOnce(async (_wallet, _config, options) => {
        await options.onProgress({ actionTimeline: [submitted] });
        return report();
      })
      .mockImplementationOnce(async (_wallet, _config, options) => {
        expect(options.restoredTimeline).toEqual([submitted]);
        return report();
      });
    route({
      "/execution": (body) => {
        const operation = (body as { operation: string }).operation;
        if (operation === "acquire") return acquired();
        checkpointCalls += 1;
        return checkpointCalls === 1
          ? errResult("EXECUTION_CHECKPOINT_CONFLICT", 409)
          : saved();
      },
    });

    const cycle = await worker().runOnce("run-1");

    expect(cycle.outcome).toBe("ran");
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("persists a retry once the immediate attempts are spent", async () => {
    runDailyQuest.mockRejectedValue(new Error("still down"));
    route({
      "/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired()
          : saved(),
    });

    const cycle = await worker().runOnce("run-1");

    expect(cycle.outcome).toBe("retry_scheduled");
    const final = checkpoints().at(-1)!;
    expect(final).toMatchObject({
      status: "waiting_retry",
      releaseLease: true,
    });
    // Released, so another worker can pick it up after the delay.
    expect(final.nextRetryAt).toBeTruthy();
  });

  it("stops and asks the owner when only they can unblock it", async () => {
    runDailyQuest.mockResolvedValue(
      report({
        succeeded: false,
        questCompleted: false,
        blockingCode: "AGENT_WALLET_NOT_KEYHOLDER",
        blockingReason: "The agent wallet needs a vendor key.",
      }),
    );
    route({
      "/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired()
          : saved(),
    });

    const cycle = await worker().runOnce("run-1");

    expect(cycle.outcome).toBe("decision_required");
    const final = checkpoints().at(-1)!;
    expect(final.status).toBe("decision_required");
    expect(final.pendingDecision).toMatchObject({
      code: "AGENT_WALLET_NOT_KEYHOLDER",
      options: ["retry", "cancel"],
    });
    // Spinning on something only a human can fix would burn the budget.
    expect(final.nextRetryAt).toBeNull();
  });

  it("marks a fatal failure failed instead of scheduling a retry", async () => {
    runDailyQuest.mockResolvedValue(
      report({ succeeded: false, blockingCode: "UNSUPPORTED_ROUTE" }),
    );
    route({
      "/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired()
          : saved(),
    });

    await worker().runOnce("run-1");

    const final = checkpoints().at(-1)!;
    expect(final).toMatchObject({ status: "failed", nextRetryAt: null });
  });

  it("keeps confirmed work in the checkpoint when the run only partly settled", async () => {
    runDailyQuest.mockResolvedValue(
      report({
        succeeded: false,
        questCompleted: false,
        blockingCode: "GATEWAY_UNREACHABLE",
        tasks: [
          {
            taskId: "t1",
            title: "t",
            taskType: "uniswap_swap",
            status: "claimed",
          },
          {
            taskId: "t2",
            title: "t",
            taskType: "uniswap_swap",
            status: "reward_pending",
          },
        ],
      }),
    );
    route({
      "/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired()
          : saved(),
    });

    await worker().runOnce("run-1");

    const final = checkpoints().at(-1)!;
    const checkpoint = final.checkpoint as Record<string, unknown>;
    // A later failure must never erase what already landed on chain.
    expect(checkpoint.settledTaskIds).toEqual(["t1"]);
    expect(checkpoint.rewardPendingTaskIds).toEqual(["t2"]);
  });

  it("resumes from the attempt count a previous process recorded", async () => {
    runDailyQuest.mockResolvedValue(
      report({ succeeded: false, blockingCode: "GATEWAY_UNREACHABLE" }),
    );
    route({
      "/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired({ checkpoint: { attempts: 2 }, recovered: true })
          : saved(),
    });

    await worker().runOnce("run-1");

    const checkpoint = checkpoints().at(-1)!.checkpoint as Record<
      string,
      unknown
    >;
    expect(checkpoint.attempts).toBe(3);
  });

  it("sends a checkpoint bound to the version it read", async () => {
    route({
      "/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired({ state_version: 7 })
          : saved(),
    });

    await worker().runOnce("run-1");

    // Compare-and-swap: a stale worker's write must be rejected, not merged.
    expect(checkpoints().at(-1)).toMatchObject({
      expectedVersion: 7,
      attemptToken: TOKEN,
      executionId: EXEC,
    });
  });
});

describe("owner decisions", () => {
  it("finalizes instead of retrying when the owner asked it to", async () => {
    route({
      "/quests/run-1/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired({ checkpoint: { ownerResolution: "finalize" } })
          : saved(),
      "/quests/run-1/complete": () => okResult({ transactionHash: "0xkey" }),
    });

    const cycle = await worker().runOnce("run-1");

    // The owner's answer is acted on, not re-planned around.
    expect(runDailyQuest).not.toHaveBeenCalled();
    expect(cycle).toMatchObject({ outcome: "ran", runId: "run-1" });
    expect(checkpoints()[0]).toMatchObject({
      status: "completed",
      releaseLease: true,
    });
  });

  it("does not carry the owner's answer into a later attempt", async () => {
    route({
      "/quests/run-1/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired({
              checkpoint: {
                ownerResolution: "retry",
                attempts: 2,
                actionTimeline: [
                  {
                    actionName: "p2e_uniswap_swap",
                    purpose: "quest_task",
                    taskId: "t1",
                    status: "broadcasting",
                  },
                  {
                    actionName: "p2e_vendor_buy",
                    purpose: "quest_task",
                    taskId: "t2",
                    status: "confirmed",
                    txHash: "0xhash",
                  },
                ],
              },
            })
          : saved(),
      "/quests/run-1/complete": () => okResult({}),
    });

    await worker().runOnce("run-1");

    expect(runDailyQuest).toHaveBeenCalled();
    expect(checkpoints()[0]?.checkpoint).not.toHaveProperty("ownerResolution");
    expect(runDailyQuest.mock.calls[0]?.[2]).toMatchObject({
      restoredTimeline: [
        expect.objectContaining({
          actionName: "p2e_vendor_buy",
          status: "confirmed",
        }),
      ],
    });
  });
});

describe("deadline finalization", () => {
  const NOW = 1_000_000;

  const stalled = (msRemaining: number | null) =>
    report({
      succeeded: false,
      questCompleted: false,
      blockingCode: "OWNER_REWARD_DECISION_REQUIRED",
      runEndsAt:
        msRemaining === null ? null : new Date(NOW + msRemaining).toISOString(),
      tasks: [
        {
          taskId: "t1",
          title: "t",
          taskType: "uniswap_swap",
          status: "reward_pending",
        },
      ],
    });

  it("finalizes inside the buffer instead of scheduling another retry", async () => {
    runDailyQuest.mockResolvedValue(stalled(60_000));
    route({
      "/quests/run-1/complete": () => okResult({ transactionHash: "0xkey" }),
      "/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired()
          : saved(),
    });

    const cycle = await worker().runOnce("run-1");

    // The key and bonus dwarf one task reward, and both are lost at the
    // deadline; the unresolved reward stays recorded for recovery.
    expect(cycle.outcome).toBe("ran");
    const final = checkpoints().at(-1)!;
    expect(final.status).toBe("completed");
    const checkpoint = final.checkpoint as Record<string, unknown>;
    expect(checkpoint.finalizedAtDeadline).toBe(true);
    expect(checkpoint.keyTxHash).toBe("0xkey");
    expect(checkpoint.rewardPendingTaskIds).toEqual(["t1"]);
  });

  it("asks the owner while there is still time to choose", async () => {
    runDailyQuest.mockResolvedValue(stalled(3_600_000));
    route({
      "/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired()
          : saved(),
    });

    const cycle = await worker().runOnce("run-1");

    expect(cycle.outcome).toBe("decision_required");
    expect(checkpoints().at(-1)?.decisionDeadline).toBe(
      new Date(NOW + 3_600_000 - 120_000).toISOString(),
    );
    expect(
      call.mock.calls.filter(([p]) =>
        String(p).includes("/quests/run-1/complete"),
      ),
    ).toHaveLength(0);
  });

  it("does not finalize a fatally blocked run at the deadline", async () => {
    runDailyQuest.mockResolvedValue(
      report({
        succeeded: false,
        blockingCode: "NOTHING_EXECUTABLE",
        runEndsAt: new Date(NOW + 60_000).toISOString(),
      }),
    );
    route({
      "/quests/run-1/complete": () => okResult({}),
      "/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired()
          : saved(),
    });

    await worker().runOnce("run-1");

    // Nothing ran, so there is no key to secure — finalizing would be noise.
    const final = checkpoints().at(-1)!;
    expect(final.status).toBe("failed");
  });

  it("asks the owner without an automatic deadline when none is known", async () => {
    runDailyQuest.mockResolvedValue(stalled(null));
    route({
      "/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired()
          : saved(),
    });

    const cycle = await worker().runOnce("run-1");

    expect(cycle.outcome).toBe("decision_required");
    expect(checkpoints().at(-1)?.decisionDeadline).toBeNull();
  });
});

describe("AgentWorker.start", () => {
  it("refuses to start when the network preflight fails", async () => {
    assertAgentNetwork.mockRejectedValue(new Error("wrong chain"));

    await expect(worker().start()).rejects.toThrow(/wrong chain/);
    expect(runDailyQuest).not.toHaveBeenCalled();
  });

  it("polls for the configured number of cycles", async () => {
    route({
      "/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired()
          : saved(),
    });

    const cycles = await worker({ maxCycles: 2 }).start();

    expect(cycles).toHaveLength(2);
    expect(cycles.every((cycle) => cycle.outcome === "ran")).toBe(true);
  });

  it("does not sleep after its final cycle", async () => {
    route({
      "/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired()
          : saved(),
    });

    await worker({ maxCycles: 1 }).start();

    expect(sleep).not.toHaveBeenCalledWith(30_000);
  });

  it("survives an unexpected error and keeps polling", async () => {
    call.mockRejectedValue(new Error("boom"));

    const cycles = await worker({ maxCycles: 2 }).start();

    // One bad cycle must not stop every other owner's work.
    expect(cycles).toHaveLength(2);
    expect(cycles[0]).toMatchObject({ outcome: "retry_scheduled" });
  });

  it("stops working a terminal run without ending the worker", async () => {
    route({
      "/execution": () => okResult({ execution: { outcome: "terminal" } }),
    });

    const cycles = await worker({ maxCycles: 3 }).start();

    // A finished run is not a finished worker: it keeps polling for the next
    // one, but never leases the run it already knows is done.
    expect(cycles.map((cycle) => cycle.outcome)).toEqual([
      "terminal",
      "no_work",
      "no_work",
    ]);
  });

  it("leaves a run alone while the server says it is not due", async () => {
    route({
      "/execution": () =>
        okResult({
          execution: { outcome: "waiting", status: "waiting_retry" },
        }),
    });

    const cycles = await worker({ maxCycles: 2 }).start();

    expect(cycles.map((cycle) => cycle.outcome)).toEqual([
      "waiting",
      "waiting",
    ]);
    expect(runDailyQuest).not.toHaveBeenCalled();
  });

  it("does not re-list the priced quest catalogue on every poll", async () => {
    route({
      "/quests/run-9/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired()
          : saved(),
      "/quests": () =>
        okResult({ runs: [{ id: "run-9", eligibility: { eligible: true } }] }),
    });

    await worker({ runId: undefined, maxCycles: 3 }).start();

    const listCalls = call.mock.calls.filter(
      ([path]) => String(path) === "/api/agent/v1/quests",
    );
    expect(listCalls).toHaveLength(1);
  });

  it("reports no work when nothing is eligible", async () => {
    route({ "/quests": () => okResult({ runs: [] }) });

    const cycles = await worker({ runId: undefined, maxCycles: 1 }).start();

    expect(cycles[0]).toEqual({ outcome: "no_work" });
    expect(runDailyQuest).not.toHaveBeenCalled();
  });

  it("picks the eligible run when none was named", async () => {
    route({
      "/quests/run-9/execution": (body) =>
        (body as { operation: string }).operation === "acquire"
          ? acquired()
          : saved(),
      "/quests": () =>
        okResult({ runs: [{ id: "run-9", eligibility: { eligible: true } }] }),
    });

    const cycles = await worker({ runId: undefined, maxCycles: 1 }).start();

    expect(cycles[0]).toMatchObject({ outcome: "ran", runId: "run-9" });
  });

  it("stops when its abort signal is already raised", async () => {
    const controller = new AbortController();
    controller.abort();

    const cycles = await worker({ signal: controller.signal }).start();

    expect(cycles).toEqual([]);
  });
});

it("does not report completion after a rejected final checkpoint", async () => {
  call.mockImplementation(async (_path, options) =>
    options.body.operation === "acquire"
      ? acquired()
      : errResult("EXECUTION_LEASE_LOST", 409),
  );
  runDailyQuest.mockResolvedValue(report());
  await expect(
    new AgentWorker(wallet, config, { sleep }).runOnce("run-1"),
  ).rejects.toThrow("checkpoint");
  expect(checkpoints()).toHaveLength(1);
});
