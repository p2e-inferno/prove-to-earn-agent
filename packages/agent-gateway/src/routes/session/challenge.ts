import { NextResponse, type NextRequest } from "next/server";
import { ethers } from "ethers";
import { agentError, agentOk } from "../../errors";
import { issueSessionChallenge } from "../../auth/grant";
import { findAgentByWallet } from "../../db/agents";
import { createPairingRoute } from "../../route-factory";
import { checkChallengeRateLimit } from "../../auth/challenge-rate-limit";

type Body = { agentWallet?: string };

export const POST = createPairingRoute({
  guard: "public",
  handler: async (req: NextRequest): Promise<NextResponse> => {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return agentError(400, "INVALID_REQUEST", "A JSON body is required");
    }

    if (!body.agentWallet || !ethers.isAddress(body.agentWallet)) {
      return agentError(
        400,
        "INVALID_REQUEST",
        "A valid agentWallet is required",
      );
    }

    const rateLimit = await checkChallengeRateLimit(req, body.agentWallet);
    if (!rateLimit.allowed) {
      return agentError(
        429,
        "RATE_LIMITED",
        "Too many session challenges. Retry shortly.",
      );
    }

    const agent = await findAgentByWallet(body.agentWallet);
    if (!agent) {
      return agentError(401, "AGENT_UNKNOWN", "This agent is not registered");
    }
    if (agent.status !== "ready" || !agent.agentWallet) {
      return agentError(409, "AGENT_NOT_READY", "This agent is not ready");
    }

    const challenge = await issueSessionChallenge(body.agentWallet);
    return agentOk(challenge);
  },
});
