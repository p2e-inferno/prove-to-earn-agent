/**
 * @jest-environment node
 */

const resolveAgentActor = jest.fn();
const peekRequest = jest.fn();
const acquireRequest = jest.fn();
const markState = jest.fn(
  async (_id: unknown, _token: unknown, _state: unknown, _patch?: unknown) =>
    true,
);
const paidInner = jest.fn();

jest.mock("./auth/actor-auth", () => ({
  resolveAgentActor: (req: unknown) => resolveAgentActor(req),
}));

jest.mock("./db/idempotency", () => {
  const actual = jest.requireActual("./db/idempotency");
  return {
    ...actual,
    peekRequest: (identity: unknown) => peekRequest(identity),
    acquireRequest: (identity: unknown) => acquireRequest(identity),
    markState: (id: unknown, token: unknown, state: unknown, patch?: unknown) =>
      markState(id, token, state, patch),
  };
});

jest.mock("./payments/x402", () => ({
  getHttpResourceServer: jest.fn(() => ({})),
}));

// Stands in for the paywall: records that it ran, then delegates to the
// handler the factory wrapped.
jest.mock("@x402/next", () => ({
  withX402FromHTTPServer: (handler: (req: unknown) => Promise<unknown>) => {
    return async (req: unknown) => {
      paidInner();
      return handler(req);
    };
  },
}));

jest.mock("@/lib/utils/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { createAgentRoute } from "./route-factory";
import { hashRequest } from "./db/idempotency";

const AGENT = {
  id: "agent-1",
  ownerUserId: "did:privy:owner",
  agentWallet: "0xagent",
  rewardWallet: "0xowner",
  displayName: "a",
  agentbookHumanId: null,
  status: "active" as const,
};

function actorWith(capabilities: string[]) {
  return {
    ok: true,
    actor: {
      agent: AGENT,
      permissions: capabilities.map((capability) => ({
        capability,
        dailyQuestTemplateId: null,
      })),
      principal: {
        userId: AGENT.ownerUserId,
        executionWallet: AGENT.agentWallet,
        rewardWallet: AGENT.rewardWallet,
        actorKind: "agent" as const,
        agentId: AGENT.id,
      },
    },
  };
}

function request(headers: Record<string, string> = {}, body = "") {
  return {
    method: "POST",
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    nextUrl: { pathname: "/api/agent/v1/quests/run-1/start" },
    text: async () => body,
  } as never;
}

describe("createAgentRoute ordering", () => {
  const handler = jest.fn(
    async (): Promise<{ status: number; body: Record<string, unknown> }> => ({
      status: 200,
      body: { ok: 1 },
    }),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    peekRequest.mockResolvedValue({ outcome: "absent" });
    acquireRequest.mockResolvedValue({
      outcome: "acquired",
      id: "req-1",
      attemptToken: "token-1",
      recovered: false,
    });
  });

  const route = () => createAgentRoute({ routeId: "quests.start", handler });

  it("rejects an unknown agent without entering the paywall", async () => {
    resolveAgentActor.mockResolvedValue({
      ok: false,
      status: 401,
      code: "AGENT_UNKNOWN",
      message: "no",
    });

    const res = await route()(request({ "idempotency-key": "k1" }));

    expect(res.status).toBe(401);
    expect(paidInner).not.toHaveBeenCalled();
    expect(peekRequest).not.toHaveBeenCalled();
  });

  it("denies a missing capability before charging", async () => {
    resolveAgentActor.mockResolvedValue(actorWith(["quests.read"]));

    const res = await route()(request({ "idempotency-key": "k1" }));

    expect(res.status).toBe(403);
    expect(paidInner).not.toHaveBeenCalled();
    expect(acquireRequest).not.toHaveBeenCalled();
  });

  it("requires an Idempotency-Key on mutations", async () => {
    resolveAgentActor.mockResolvedValue(actorWith(["quests.start"]));

    const res = await route()(request());

    expect(res.status).toBe(400);
    expect(paidInner).not.toHaveBeenCalled();
  });

  /**
   * The regression this suite exists for: reserving before payment marked the
   * key in flight during the mandatory 402 challenge, so the agent's paid retry
   * collided with its own reservation and every paid route deadlocked.
   */
  it("does not reserve before the paywall — only peeks", async () => {
    resolveAgentActor.mockResolvedValue(actorWith(["quests.start"]));

    await route()(request({ "idempotency-key": "k1" }));

    expect(peekRequest).toHaveBeenCalledTimes(1);
    const peekOrder = peekRequest.mock.invocationCallOrder[0]!;
    const paidOrder = paidInner.mock.invocationCallOrder[0]!;
    const acquireOrder = acquireRequest.mock.invocationCallOrder[0]!;

    expect(peekOrder).toBeLessThan(paidOrder);
    expect(paidOrder).toBeLessThan(acquireOrder);
  });

  it("replays a settled request without entering the paywall", async () => {
    resolveAgentActor.mockResolvedValue(actorWith(["quests.start"]));
    peekRequest.mockResolvedValue({
      outcome: "found",
      id: "req-1",
      state: "completed",
      requestHash: hashRequest({
        method: "POST",
        route: "quests.start",
        pathname: "/api/agent/v1/quests/run-1/start",
        body: {},
      }),
      responseStatus: 200,
      responseBody: { ok: true, data: { replayed: true } },
    });

    const res = await route()(request({ "idempotency-key": "k1" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { replayed: true } });
    expect(paidInner).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  // The settled replay path returns a cached response without payment, so it
  // must prove the request is the same one. Mocking a conflict out of
  // acquireRequest never exercises this: acquire runs behind the paywall.
  describe.each(["completed", "failed"] as const)(
    "settled %s replay",
    (state) => {
      const settled = (requestHash: string) => ({
        outcome: "found" as const,
        id: "req-1",
        state,
        requestHash,
        responseStatus: state === "completed" ? 200 : 400,
        responseBody: { ok: state === "completed", data: { replayed: true } },
      });

      it("rejects a changed body", async () => {
        resolveAgentActor.mockResolvedValue(actorWith(["quests.start"]));
        peekRequest.mockImplementation(async () =>
          settled(
            hashRequest({
              method: "POST",
              route: "quests.start",
              pathname: "/api/agent/v1/quests/run-1/start",
              body: { a: 1 },
            }),
          ),
        );

        const res = await route()(
          request({ "idempotency-key": "k1" }, JSON.stringify({ a: 2 })),
        );

        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe("IDEMPOTENCY_CONFLICT");
        expect(paidInner).not.toHaveBeenCalled();
      });

      it("rejects a changed pathname", async () => {
        resolveAgentActor.mockResolvedValue(actorWith(["quests.start"]));
        peekRequest.mockImplementation(async () =>
          settled(
            hashRequest({
              method: "POST",
              route: "quests.start",
              pathname: "/api/agent/v1/quests/OTHER-RUN/start",
              body: {},
            }),
          ),
        );

        const res = await route()(request({ "idempotency-key": "k1" }));

        expect(res.status).toBe(409);
        expect(paidInner).not.toHaveBeenCalled();
      });

      it("replays when the request is byte-identical", async () => {
        resolveAgentActor.mockResolvedValue(actorWith(["quests.start"]));
        peekRequest.mockImplementation(async () =>
          settled(
            hashRequest({
              method: "POST",
              route: "quests.start",
              pathname: "/api/agent/v1/quests/run-1/start",
              body: {},
            }),
          ),
        );

        const res = await route()(request({ "idempotency-key": "k1" }));

        expect(res.status).toBe(state === "completed" ? 200 : 400);
        expect(paidInner).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
      });
    },
  );

  it("replays a committed-but-unpaid effect through the paywall", async () => {
    resolveAgentActor.mockResolvedValue(actorWith(["quests.start"]));
    acquireRequest.mockResolvedValue({
      outcome: "replay",
      id: "req-1",
      state: "effect_committed",
      attemptToken: "token-1",
      responseStatus: 200,
      responseBody: { ok: true, data: { committed: true } },
    });

    const res = await route()(request({ "idempotency-key": "k1" }));

    expect(paidInner).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ ok: true, data: { committed: true } });
  });

  it("rejects a key reused with a different request", async () => {
    resolveAgentActor.mockResolvedValue(actorWith(["quests.start"]));
    acquireRequest.mockResolvedValue({ outcome: "conflict", id: "req-1" });

    const res = await route()(request({ "idempotency-key": "k1" }));

    expect(res.status).toBe(409);
    expect(handler).not.toHaveBeenCalled();
  });

  it("records effect_committed before the response leaves the handler", async () => {
    resolveAgentActor.mockResolvedValue(actorWith(["quests.start"]));

    await route()(request({ "idempotency-key": "k1" }));

    expect(markState).toHaveBeenCalledWith(
      "req-1",
      "token-1",
      "effect_committed",
      expect.objectContaining({ responseStatus: 200 }),
    );
  });

  it("keeps a 5xx retryable instead of caching it as terminally failed", async () => {
    resolveAgentActor.mockResolvedValue(actorWith(["quests.start"]));
    handler.mockResolvedValueOnce({ status: 503, body: { code: "UPSTREAM" } });

    await route()(request({ "idempotency-key": "k1" }));

    expect(markState).toHaveBeenCalledWith(
      "req-1",
      "token-1",
      "in_flight",
      expect.objectContaining({ responseStatus: 503 }),
    );
  });
});

it("reacquires authoritative execution state instead of replaying a cached lease", async () => {
  jest.clearAllMocks();
  resolveAgentActor.mockResolvedValue(actorWith(["quests.start"]));
  peekRequest.mockResolvedValue({
    outcome: "found",
    state: "completed",
    responseStatus: 200,
    responseBody: { execution: { state_version: 0 } },
  });
  let version = 1;
  const handler = jest.fn(async () => ({
    status: 200,
    body: { execution: { state_version: version++ } },
  }));
  const route = createAgentRoute({
    routeId: "executions.write",
    idempotency: false,
    handler,
  });
  const first = await route(
    request(
      { "idempotency-key": "lease" },
      JSON.stringify({ operation: "acquire" }),
    ),
  );
  const second = await route(
    request(
      { "idempotency-key": "lease" },
      JSON.stringify({ operation: "acquire" }),
    ),
  );
  expect((await first.json()).data.execution.state_version).toBe(1);
  expect((await second.json()).data.execution.state_version).toBe(2);
  expect(peekRequest).not.toHaveBeenCalled();
  expect(handler).toHaveBeenCalledTimes(2);
});
