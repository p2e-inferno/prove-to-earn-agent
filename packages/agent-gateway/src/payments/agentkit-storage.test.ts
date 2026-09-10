const evalRedis = jest.fn();
const get = jest.fn();
const set = jest.fn();
const getUpstashRedis = jest.fn();

jest.mock("@/lib/upstash/redis", () => ({
  getUpstashRedis: () => getUpstashRedis(),
}));
jest.mock("@/lib/utils/logger", () => ({
  getLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}));

import { RedisAgentKitStorage } from "./agentkit-storage";

describe("RedisAgentKitStorage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getUpstashRedis.mockReturnValue({ eval: evalRedis, get, set });
  });

  it("keeps the first-call allowance keyed by endpoint and human without expiry", async () => {
    evalRedis.mockResolvedValueOnce(1);
    const storage = new RedisAgentKitStorage();

    await expect(
      storage.tryIncrementUsage("POST /quests/start", "human-1", 100),
    ).resolves.toBe(true);
    expect(evalRedis).toHaveBeenCalledWith(
      expect.not.stringContaining("EXPIRE"),
      ["agentkit:usage:POST /quests/start:human-1"],
      ["100"],
    );
  });

  it("refuses the discount once the human's allowance is spent", async () => {
    evalRedis.mockResolvedValueOnce(0);
    const storage = new RedisAgentKitStorage();

    await expect(
      storage.tryIncrementUsage(
        "/api/agent/v1/quests/11111111-1111-4111-8111-111111111111/start",
        "human-1",
        2,
      ),
    ).resolves.toBe(false);
  });

  // Counting the concrete URL would hand every quest run its own allowance,
  // so a human could take the discount indefinitely by starting new runs.
  it("charges every run of a route against one canonical allowance", async () => {
    evalRedis.mockResolvedValue(1);
    const storage = new RedisAgentKitStorage();

    await storage.tryIncrementUsage(
      "/api/agent/v1/quests/11111111-1111-4111-8111-111111111111/start",
      "human-1",
      2,
    );
    await storage.tryIncrementUsage(
      "/api/agent/v1/quests/22222222-2222-4222-8222-222222222222/start",
      "human-1",
      2,
    );

    const keys = evalRedis.mock.calls.map((call) => call[1][0]);
    expect(keys).toEqual([
      "agentkit:usage:/api/agent/v1/quests/[runId]/start:human-1",
      "agentkit:usage:/api/agent/v1/quests/[runId]/start:human-1",
    ]);
  });

  it("keeps two humans on separate allowances for the same route", async () => {
    evalRedis.mockResolvedValue(1);
    const storage = new RedisAgentKitStorage();

    await storage.tryIncrementUsage("/api/agent/v1/quests", "human-1", 2);
    await storage.tryIncrementUsage("/api/agent/v1/quests", "human-2", 2);

    const keys = evalRedis.mock.calls.map((call) => call[1][0]);
    expect(new Set(keys).size).toBe(2);
  });

  it.each([
    ["the store is unreachable", () => getUpstashRedis.mockReturnValue(null)],
    [
      "the counter cannot be read",
      () => evalRedis.mockRejectedValueOnce(new Error("ECONNRESET")),
    ],
  ])("refuses the discount when %s", async (_case, arrange) => {
    arrange();
    const storage = new RedisAgentKitStorage();

    await expect(
      storage.tryIncrementUsage("/api/agent/v1/quests", "human-1", 2),
    ).resolves.toBe(false);
  });

  it("retains a bounded lifetime for replay nonces", async () => {
    const storage = new RedisAgentKitStorage();
    await storage.recordNonce("nonce-1");

    expect(set).toHaveBeenCalledWith("agentkit:nonce:nonce-1", "1", {
      ex: 86_400,
    });
  });

  // AgentKit reads a false here as "this nonce is fresh", so an unreadable
  // store has to answer true or replay protection is waived.
  it.each([
    ["the store is unreachable", () => getUpstashRedis.mockReturnValue(null)],
    [
      "the nonce cannot be read",
      () => get.mockRejectedValueOnce(new Error("ECONNRESET")),
    ],
  ])("treats a nonce as already used when %s", async (_case, arrange) => {
    arrange();
    const storage = new RedisAgentKitStorage();

    await expect(storage.hasUsedNonce("nonce-1")).resolves.toBe(true);
  });

  it("reports an unseen nonce as fresh", async () => {
    get.mockResolvedValueOnce(null);
    const storage = new RedisAgentKitStorage();

    await expect(storage.hasUsedNonce("nonce-1")).resolves.toBe(false);
  });
});
