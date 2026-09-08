import { NextResponse, type NextRequest } from "next/server";
import {
  listOwnerAgentExecutions,
  resolveOwnerAgentDecision,
} from "@/lib/quests/daily-quests/services/agent-execution";
import { agentError, toEnvelope } from "../../errors";
import { createPairingRoute } from "../../route-factory";

export const GET = createPairingRoute({
  guard: "owner-privy-session",
  handler: async (_req, params, ownerUserId) => {
    if (!ownerUserId)
      return agentError(401, "OWNER_AUTH_REQUIRED", "Sign in required");
    if (!params.agentId)
      return agentError(400, "INVALID_REQUEST", "Missing agentId");
    const result = await listOwnerAgentExecutions(ownerUserId, params.agentId);
    const { status, envelope } = toEnvelope(result.status, result.body);
    return NextResponse.json(envelope, { status });
  },
});

export const POST = createPairingRoute({
  guard: "owner-privy-session",
  handler: async (req: NextRequest, params, ownerUserId) => {
    if (!ownerUserId)
      return agentError(401, "OWNER_AUTH_REQUIRED", "Sign in required");
    if (!params.agentId)
      return agentError(400, "INVALID_REQUEST", "Missing agentId");
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return agentError(400, "INVALID_REQUEST", "A JSON body is required");
    }
    const result = await resolveOwnerAgentDecision(
      ownerUserId,
      params.agentId,
      body,
    );
    const { status, envelope } = toEnvelope(result.status, result.body);
    return NextResponse.json(envelope, { status });
  },
});
