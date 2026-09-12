/** @jest-environment node */
import { withX402FromHTTPServer } from "@x402/next";
import { NextRequest, NextResponse } from "next/server";

function paymentVerifiedResult() {
  return {
    type: "payment-verified" as const,
    paymentPayload: {},
    paymentRequirements: {},
    declaredExtensions: {},
    cancellationDispatcher: { cancel: jest.fn() },
    beforeHandlerSettlement: undefined,
  };
}

function httpServer(result: ReturnType<typeof paymentVerifiedResult>) {
  return {
    routes: {},
    server: { hasExtension: () => true },
    initialize: jest.fn().mockResolvedValue(undefined),
    processHTTPRequest: jest.fn().mockResolvedValue(result),
    processSettlement: jest.fn().mockResolvedValue({
      success: true,
      headers: {},
    }),
    createFailurePathSettlementHeaders: jest.fn(),
  };
}

function request() {
  return new NextRequest("https://p2einferno.example/api/agent/v1/quests", {
    method: "GET",
  });
}

describe("canonical x402 settlement", () => {
  it("settles a successful economic HTTP response once", async () => {
    const result = paymentVerifiedResult();
    const server = httpServer(result);
    const handler = withX402FromHTTPServer(
      async () => NextResponse.json({ ok: true }),
      server as never,
      undefined,
      undefined,
      false,
    );

    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(server.processSettlement).toHaveBeenCalledTimes(1);
    expect(result.cancellationDispatcher.cancel).not.toHaveBeenCalled();
  });

  it("cancels instead of settling a failed economic HTTP response", async () => {
    const result = paymentVerifiedResult();
    const server = httpServer(result);
    const handler = withX402FromHTTPServer(
      async () => NextResponse.json({ ok: false }, { status: 409 }),
      server as never,
      undefined,
      undefined,
      false,
    );

    const response = await handler(request());

    expect(response.status).toBe(409);
    expect(server.processSettlement).not.toHaveBeenCalled();
    expect(result.cancellationDispatcher.cancel).toHaveBeenCalledWith({
      reason: "handler_failed",
      responseStatus: 409,
    });
  });
});
