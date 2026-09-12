import { NextResponse } from "next/server";
import { z } from "zod";
import {
  recordAgentRunReport,
  listAgentRunReports,
  type AgentRunReportInput,
} from "@vendor/quests/reports";
import { createAgentRoute, createPairingRoute } from "../../route-factory";
import { agentError, toEnvelope } from "../../errors";

export const POST = createAgentRoute({
  routeId: "reports.write",
  handler: async (ctx) =>
    recordAgentRunReport(
      ctx.principal,
      (ctx.body ?? {}) as AgentRunReportInput,
    ),
});

/** Owner-facing history, so a human can see every run their agents attempted. */
export const GET = createPairingRoute({
  guard: "owner-privy-session",
  handler: async (req, _params, ownerUserId) => {
    if (!ownerUserId) {
      return agentError(
        401,
        "OWNER_AUTH_REQUIRED",
        "Owner authentication is required",
      );
    }
    const params = req.nextUrl.searchParams;
    const agentId = params.get("agentId") ?? undefined;
    if (agentId && !z.string().uuid().safeParse(agentId).success) {
      return agentError(400, "INVALID_REQUEST", "Invalid agentId");
    }
    const result = await listAgentRunReports(ownerUserId, {
      limit: Number(params.get("limit") ?? 20),
      offset: Number(params.get("offset") ?? 0),
      agentId,
    });
    const { status, envelope } = toEnvelope(result.status, result.body);
    return NextResponse.json(envelope, { status });
  },
});
