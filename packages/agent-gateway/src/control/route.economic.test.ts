/** @jest-environment node */
import { NextRequest } from "next/server";

jest.mock("../auth/headless-session", () => ({
  resolveHeadlessActor: jest.fn(),
}));
jest.mock("../env", () => ({
  headlessAgentApiEnabled: () => true,
  headlessAgentIssuer: () => "https://p2einferno.example",
}));
jest.mock("@vendor/agent-rate-limiter", () => ({
  rateLimiter: { check: jest.fn() },
}));
jest.mock("../payments/x402", () => ({
  invokeCanonicalEconomicRoute: jest.fn(),
}));

import { createHeadlessControlRoute } from "./route";

const mockResolveHeadlessActor = jest.requireMock("../auth/headless-session")
  .resolveHeadlessActor as jest.Mock;
const mockRateLimiter = jest.requireMock("@vendor/agent-rate-limiter")
  .rateLimiter.check as jest.Mock;
const mockInvokeCanonicalEconomicRoute = jest.requireMock("../payments/x402")
  .invokeCanonicalEconomicRoute as jest.Mock;

describe("headless economic control routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveHeadlessActor.mockResolvedValue({
      claims: { clientId: "client", scopes: ["quests:read"] },
      authorization: {},
      agent: {},
    });
    mockRateLimiter.mockResolvedValue({ success: true, unavailable: false });
    mockInvokeCanonicalEconomicRoute.mockImplementation(
      async (_request, options) => options.handler(),
    );
  });

  it("routes the control list through quests.list", async () => {
    const route = createHeadlessControlRoute({
      scope: "quests:read",
      economicRoute: { id: "quests.list" },
      handler: async () => ({ runs: [] }),
    });

    const response = await route(
      new NextRequest("https://p2einferno.example/api/agent-control/v1/quests"),
    );

    expect(response.status).toBe(200);
    expect(mockInvokeCanonicalEconomicRoute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ routeId: "quests.list" }),
    );
  });

  it("routes the control assessment through quests.assessment", async () => {
    const route = createHeadlessControlRoute({
      scope: "quests:read",
      economicRoute: {
        id: "quests.assessment",
        params: ({ runId }) => ({ runId: runId! }),
      },
      handler: async () => ({ assessment: {} }),
    });

    const response = await route(
      new NextRequest(
        "https://p2einferno.example/api/agent-control/v1/quests/run-1/assessment",
      ),
      { params: { runId: "run-1" } },
    );

    expect(response.status).toBe(200);
    expect(mockInvokeCanonicalEconomicRoute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        routeId: "quests.assessment",
        params: { runId: "run-1" },
      }),
    );
  });
});
