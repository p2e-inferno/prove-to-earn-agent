import { NextResponse, type NextRequest } from "next/server";
import { agentError, agentOk } from "../../errors";
import { listAgentsForOwner, revokeAgent } from "../../db/agents";
import { createPairingRoute } from "../../route-factory";

export const GET = createPairingRoute({
  guard: "owner-privy-session",
  handler: async (
    _req: NextRequest,
    _params,
    ownerUserId: string | null,
  ): Promise<NextResponse> => {
    if (!ownerUserId) {
      return agentError(
        401,
        "OWNER_AUTH_REQUIRED",
        "Owner authentication is required",
      );
    }
    const agents = await listAgentsForOwner(ownerUserId);
    return agentOk({ agents });
  },
});

export const POST = createPairingRoute({
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

    const agentId = params.agentId;
    if (!agentId) {
      return agentError(400, "INVALID_REQUEST", "Missing agentId");
    }

    const revoked = await revokeAgent(agentId, ownerUserId);
    if (!revoked) {
      return agentError(
        404,
        "AGENT_UNKNOWN",
        "Agent not found for this account",
      );
    }

    return agentOk({ agentId, status: "revoked" });
  },
});
