/**
 * @jest-environment node
 */

const chatCompletion = jest.fn();

jest.mock("@/lib/ai/client", () => ({
  chatCompletion: (...args: unknown[]) => chatCompletion(...args),
}));

import { planAndExecute, type PlannerDeps } from "./planner";
import type { ActionCandidate } from "./actions/types";
import type { CandidateObservation } from "./candidates";

const observe = jest.fn();
const executeCandidate = jest.fn();
const askOwner = jest.fn();

const STATE = "state-v1";

const id = (seed: string) => `cand_${seed.repeat(32).slice(0, 32)}`;

function candidate(
  seed: string,
  overrides: Partial<ActionCandidate> = {},
): ActionCandidate {
  return {
    candidateId: id(seed),
    actionName: "p2e_vendor_buy",
    actionVersion: 2,
    purpose: { kind: "quest_task", taskId: "t-buy" },
    input: { amountRaw: "1000" },
    analysis: {
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
    },
    stateVersion: STATE,
    estimatedCostUsd: null,
    usefulEffects: 1,
    rank: 1,
    explanation: "Complete the buy.",
    expiresAt: null,
    ...overrides,
  } as ActionCandidate;
}

function observation(
  candidates: ActionCandidate[],
  overrides: Partial<CandidateObservation> = {},
): CandidateObservation {
  return {
    stateVersion: STATE,
    blockNumber: "1",
    assetRequirements: { ETH: "0", USDC: "0", UP: "0", DG: "0" },
    balances: [],
    candidates,
    ownerBlockers: [],
    fatalBlockers: [],
    ...overrides,
  };
}

const tasks = [
  {
    id: "t-buy",
    title: "Buy DG with UP",
    taskType: "vendor_buy",
    taskConfig: { required_amount: "1000" },
  },
  {
    id: "t-swap",
    title: "Swap USDC for UP",
    taskType: "uniswap_swap",
    taskConfig: { pair: "UP_USDC", direction: "B_TO_A" },
  },
];

const deps = {
  config: { chainId: 8453 },
  tasks,
  observe: (...args: unknown[]) => observe(...args),
  executeCandidate: (...args: unknown[]) => executeCandidate(...args),
  askOwner: (...args: unknown[]) => askOwner(...args),
} as unknown as PlannerDeps;

/** An assistant turn that calls one tool, as the client returns it. */
function calls(name: string, args: Record<string, unknown> = {}, id = "c1") {
  return {
    success: true,
    finishReason: "tool_calls",
    toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
    assistantMessage: { role: "assistant", content: null, tool_calls: [] },
  };
}

function answers(content = "done") {
  return { success: true, finishReason: "stop", content };
}

const confirmed = (taskId: string) => ({
  candidate: candidate("a"),
  result: {
    status: "confirmed",
    txHash: `0x${"11".repeat(32)}`,
    approvals: [],
    blockNumber: "1",
  },
  taskOutcome: {
    taskId,
    title: taskId,
    taskType: "vendor_buy",
    status: "claimed" as const,
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.OPENROUTER_API_KEY = "test-key";
  observe.mockResolvedValue(observation([candidate("a")]));
  executeCandidate.mockImplementation(async () => confirmed("t-buy"));
  askOwner.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
});

describe("planAndExecute", () => {
  it("executes the candidate the model selected", async () => {
    chatCompletion
      .mockResolvedValueOnce(calls("observe_run"))
      .mockResolvedValueOnce(
        calls("execute_candidate", { candidateId: id("a") }, "c2"),
      )
      .mockResolvedValue(answers());

    const result = await planAndExecute(deps);

    expect(executeCandidate).toHaveBeenCalledTimes(1);
    expect(executeCandidate.mock.calls[0]![0]).toMatchObject({
      candidateId: id("a"),
    });
    expect(result.outcomes.map((o) => o.taskId)).toEqual(["t-buy"]);
    expect(result.planned).toBe(true);
  });

  it("re-observes after a state change rather than reusing the old view", async () => {
    chatCompletion
      .mockResolvedValueOnce(calls("observe_run"))
      .mockResolvedValueOnce(
        calls("execute_candidate", { candidateId: id("a") }, "c2"),
      )
      .mockResolvedValueOnce(
        calls("execute_candidate", { candidateId: id("a") }, "c3"),
      )
      .mockResolvedValue(answers());

    await planAndExecute(deps);

    // The second execute must be refused: executing invalidates the
    // observation, and acting on stale state is the whole risk here.
    expect(executeCandidate).toHaveBeenCalledTimes(1);
  });

  it("refuses a candidate id the observation never offered", async () => {
    chatCompletion
      .mockResolvedValueOnce(calls("observe_run"))
      .mockResolvedValueOnce(
        calls("execute_candidate", { candidateId: id("f") }, "c2"),
      )
      .mockResolvedValue(answers());

    await planAndExecute(deps);

    expect(executeCandidate).not.toHaveBeenCalled();
  });

  it("refuses to execute before it has observed anything", async () => {
    chatCompletion
      .mockResolvedValueOnce(
        calls("execute_candidate", { candidateId: id("a") }),
      )
      .mockResolvedValue(answers());

    await planAndExecute(deps);

    expect(executeCandidate).not.toHaveBeenCalled();
  });

  it("ignores a tool it invented and sends no transaction", async () => {
    chatCompletion
      .mockResolvedValueOnce(
        calls("transfer_funds", {
          to: "0x000000000000000000000000000000000000dead",
          amount: "1000000",
        }),
      )
      .mockResolvedValue(answers());

    const result = await planAndExecute(deps);

    expect(executeCandidate).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([]);
  });

  it("rejects malformed execute arguments instead of guessing", async () => {
    chatCompletion
      .mockResolvedValueOnce(calls("observe_run"))
      .mockResolvedValueOnce(
        // An arbitrary recipient is not part of the schema at all.
        calls(
          "execute_candidate",
          { to: "0x000000000000000000000000000000000000dead" },
          "c2",
        ),
      )
      .mockResolvedValue(answers());

    await planAndExecute(deps);

    expect(executeCandidate).not.toHaveBeenCalled();
  });

  it("records an owner question when no candidate can resolve the blocker", async () => {
    observe.mockResolvedValue(
      observation([], {
        ownerBlockers: [
          {
            taskId: "t-buy",
            code: "AGENT_WALLET_NOT_KEYHOLDER",
            message: "needs a key",
          },
        ],
      }),
    );
    chatCompletion
      .mockResolvedValueOnce(calls("observe_run"))
      .mockResolvedValueOnce(
        calls(
          "ask_owner",
          { question: "Your agent wallet needs a vendor key. Grant one?" },
          "c2",
        ),
      )
      .mockResolvedValue(answers());

    const result = await planAndExecute(deps);

    expect(result.questions).toEqual([
      {
        question: "Your agent wallet needs a vendor key. Grant one?",
        blockedTaskId: "t-buy",
      },
    ]);
    expect(askOwner).toHaveBeenCalledTimes(1);
  });

  it("refuses an owner question while a candidate could still resolve it", async () => {
    chatCompletion
      .mockResolvedValueOnce(calls("observe_run"))
      .mockResolvedValueOnce(
        calls("ask_owner", { question: "Send me funds?" }, "c2"),
      )
      .mockResolvedValue(answers());

    const result = await planAndExecute(deps);

    // Interrupting the owner for something the agent can do itself is the
    // failure this guard exists to prevent.
    expect(result.questions).toEqual([]);
    expect(askOwner).not.toHaveBeenCalled();
  });

  it("keeps confirmed work when the model fails mid-plan", async () => {
    chatCompletion
      .mockResolvedValueOnce(calls("observe_run"))
      .mockResolvedValueOnce(
        calls("execute_candidate", { candidateId: id("a") }, "c2"),
      )
      .mockResolvedValueOnce({ success: false, error: "upstream down" });
    observe
      .mockResolvedValueOnce(observation([candidate("a")]))
      .mockResolvedValue(observation([candidate("b"), candidate("c")]));

    const result = await planAndExecute(deps);

    // The buy is on-chain and claimed; discarding it would lose real work.
    expect(result.outcomes.map((o) => o.taskId)).toEqual(["t-buy"]);
    expect(result.planned).toBe(true);
  });

  it("does not let the runtime choose even one candidate without a model", async () => {
    delete process.env.OPENROUTER_API_KEY;

    const result = await planAndExecute(deps);

    expect(chatCompletion).not.toHaveBeenCalled();
    expect(executeCandidate).not.toHaveBeenCalled();
    expect(result.planned).toBe(false);
    expect(result.stopCode).toBe("PLANNER_SELECTION_REQUIRED");
  });

  it("waits rather than choosing between candidates with no model", async () => {
    delete process.env.OPENROUTER_API_KEY;
    observe.mockResolvedValue(observation([candidate("a"), candidate("b")]));

    const result = await planAndExecute(deps);

    // Picking one unreasoned would be an unreviewed financial decision.
    expect(executeCandidate).not.toHaveBeenCalled();
    expect(result.planned).toBe(false);
  });

  it("stops when the model answers instead of calling a tool", async () => {
    observe.mockResolvedValue(observation([candidate("a"), candidate("b")]));
    chatCompletion.mockResolvedValue(answers());

    await planAndExecute(deps);

    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(executeCandidate).not.toHaveBeenCalled();
  });

  it("never shows the model anything it could turn into calldata", async () => {
    chatCompletion
      .mockResolvedValueOnce(calls("observe_run"))
      .mockResolvedValue(answers());

    await planAndExecute(deps);

    const toolTurn = chatCompletion.mock.calls
      .flatMap(
        (call) =>
          (call[0] as { messages: Array<{ role: string; content: string }> })
            .messages,
      )
      .find((message) => message.role === "tool");
    const payload = JSON.stringify(toolTurn?.content ?? "");

    // The candidate's validated input stays server-side; the model gets an id.
    expect(payload).not.toMatch(/0x[a-fA-F0-9]{40}/);
    expect(payload).toContain("candidateId");
  });
});
