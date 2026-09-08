/**
 * @jest-environment node
 */

const chatCompletion = jest.fn();

jest.mock("@/lib/ai/client", () => ({
  chatCompletion: (...args: unknown[]) => chatCompletion(...args),
}));

import { narrateRun, type RunFacts } from "./brain";
import type { RunnerConfig } from "./config";

const config = { llmModel: undefined } as unknown as RunnerConfig;

// Absent by default so the existing cases exercise the deterministic path
// without reaching the network.
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.OPENROUTER_API_KEY;
});

function facts(overrides: Partial<RunFacts> = {}): RunFacts {
  return {
    runId: "run-1",
    questTitle: "Scholarship Grind",
    agentAddress: "0xagent",
    walletProvider: "cdp",
    tasks: [],
    questCompleted: false,
    totalPaidCalls: 0,
    discountedCalls: 0,
    ...overrides,
  };
}

describe("narrateRun", () => {
  it("reports a fully completed quest", async () => {
    const narrative = await narrateRun(
      config,
      facts({
        questCompleted: true,
        keyTxHash: "0xkey",
        tasks: [
          {
            taskId: "t1",
            title: "Swap ETH for UP",
            taskType: "uniswap_swap",
            status: "claimed",
            rewardAmount: 40,
          },
        ],
      }),
    );

    expect(narrative.source).toBe("deterministic");
    expect(narrative.headline).toContain("Completed");
    expect(narrative.summary).toContain("40 xDG");
    expect(narrative.summary).toContain("completion key");
  });

  /**
   * The behaviour this module exists for: a run that could not finish must
   * still tell its owner what was done, what was not, and why.
   */
  it("reports partial progress instead of going silent", async () => {
    const narrative = await narrateRun(
      config,
      facts({
        tasks: [
          {
            taskId: "t1",
            title: "Swap ETH for UP",
            taskType: "uniswap_swap",
            status: "claimed",
            rewardAmount: 40,
          },
          {
            taskId: "t2",
            title: "Daily check-in",
            taskType: "daily_checkin",
            status: "skipped",
            detail: "This agent cannot perform 'daily_checkin' yet.",
          },
        ],
        blockingReason:
          "Some tasks were not completed, so the quest was not finalized.",
      }),
    );

    expect(narrative.headline).toContain("Partly done");
    expect(narrative.summary).toContain("Swap ETH for UP");
    expect(narrative.summary).toContain("Daily check-in");
    expect(narrative.summary).toContain("not finalized");
  });

  it("turns a known failure code into an actionable next step", async () => {
    const narrative = await narrateRun(
      config,
      facts({
        tasks: [
          {
            taskId: "t1",
            title: "Swap ETH for UP",
            taskType: "uniswap_swap",
            status: "failed",
            code: "INSUFFICIENT_FUNDS",
            detail: "insufficient funds for gas",
          },
        ],
      }),
    );

    expect(narrative.nextSteps).toContainEqual(
      expect.stringContaining("more ETH on Base"),
    );
  });

  it("never throws when the quest could not even be started", async () => {
    const narrative = await narrateRun(
      config,
      facts({ blockingReason: "No daily quest runs are open right now." }),
    );

    expect(narrative.headline).toContain("Could not start");
    expect(narrative.summary).toContain("No daily quest runs are open");
  });
});

describe("narrateRun with a model configured", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  it("uses the model's wording when it returns usable JSON", async () => {
    chatCompletion.mockResolvedValue({
      success: true,
      finishReason: "stop",
      content: JSON.stringify({
        headline: "Finished the daily quest.",
        summary: "Both tasks landed and the key was granted.",
        nextSteps: ["Nothing to do."],
      }),
    });

    const narrative = await narrateRun(config, facts({ questCompleted: true }));

    expect(narrative.source).toBe("llm");
    expect(narrative.headline).toBe("Finished the daily quest.");
    expect(narrative.nextSteps).toEqual(["Nothing to do."]);
  });

  it("falls back to the deterministic narrative when the model errors", async () => {
    chatCompletion.mockResolvedValue({
      success: false,
      error: "upstream unavailable",
      code: "AI_ERROR",
    });

    const narrative = await narrateRun(config, facts());

    expect(narrative.source).toBe("deterministic");
    expect(narrative.headline).toBeTruthy();
  });

  it("falls back rather than throwing when the model returns unusable JSON", async () => {
    chatCompletion.mockResolvedValue({
      success: true,
      finishReason: "stop",
      content: "not json",
    });

    await expect(narrateRun(config, facts())).resolves.toMatchObject({
      source: "deterministic",
    });
  });

  it("never calls the model without a key", async () => {
    delete process.env.OPENROUTER_API_KEY;

    const narrative = await narrateRun(config, facts());

    // chatCompletion throws on a missing key instead of returning an error, so
    // reaching it at all would make narration throw.
    expect(chatCompletion).not.toHaveBeenCalled();
    expect(narrative.source).toBe("deterministic");
  });
});
