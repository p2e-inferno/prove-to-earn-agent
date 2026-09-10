import { NextResponse, type NextRequest } from "next/server";
import { agentError, agentOk } from "../../errors";
import { findAgentById } from "../../db/agents";
import { publicAgent } from "./manage";
import { createPairingRoute } from "../../route-factory";
import { PATCH } from "./manage";

export { PATCH };

export const GET = createPairingRoute({
  guard: "owner-privy-session",
  handler: async (
    _req: NextRequest,
    params,
    ownerUserId: string | null,
  ): Promise<NextResponse> => {
    if (!ownerUserId) {
      return agentError(
        401,
        "OWNER_AUTH_REQUIRED",
        "Owner authentication is required",
      );
    }
    if (!params.agentId) {
      return agentError(400, "INVALID_REQUEST", "Missing agentId");
    }
    const agent = await findAgentById(params.agentId);
    if (!agent || agent.ownerUserId !== ownerUserId) {
      return agentError(
        404,
        "AGENT_UNKNOWN",
        "Agent not found for this account",
      );
    }
    return agentOk({ agent: publicAgent(agent) });
  },
});
