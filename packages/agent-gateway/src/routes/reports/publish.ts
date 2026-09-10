import { NextResponse } from "next/server";
import {
  recordAgentRunReport,
  listAgentRunReports,
  type AgentRunReportInput,
} from "@/lib/quests/daily-quests/services/reports";
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
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? 20);
    const agentId = req.nextUrl.searchParams.get("agentId") ?? undefined;
    const result = await listAgentRunReports(ownerUserId, limit, agentId);
    const { status, envelope } = toEnvelope(result.status, result.body);
    return NextResponse.json(envelope, { status });
  },
});
