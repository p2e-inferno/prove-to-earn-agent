import { NextResponse, type NextRequest } from "next/server";
import { ethers } from "ethers";
import { agentError, agentOk } from "../../errors";
import {
  consumeSessionChallenge,
  loadSessionChallenge,
  recoverPersonalSigner,
} from "../../auth/grant";
import { issueAgentSession } from "../../auth/session";
import { findAgentByWallet } from "../../db/agents";
import { createPairingRoute } from "../../route-factory";

type Body = { agentWallet?: string; nonce?: string; signature?: string };

export const POST = createPairingRoute({
  guard: "agent-wallet-signature",
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
    if (
      !body.nonce ||
      !/^0x[0-9a-f]{48}$/i.test(body.nonce) ||
      !body.signature ||
      body.signature.length > 1024
    ) {
      return agentError(
        400,
        "INVALID_REQUEST",
        "A valid nonce and signature are required",
      );
    }

    const challenge = await loadSessionChallenge({
      nonce: body.nonce,
      agentWallet: body.agentWallet,
    });
    if (!challenge) {
      return agentError(
        401,
        "NONCE_INVALID",
        "Challenge is invalid, expired or already used",
      );
    }

    const signer = recoverPersonalSigner(challenge.message, body.signature);
    if (!signer || signer.toLowerCase() !== body.agentWallet.toLowerCase()) {
      return agentError(
        401,
        "SIGNATURE_INVALID",
        "Signature does not match the agent wallet",
      );
    }

    const consumed = await consumeSessionChallenge({
      nonce: body.nonce,
      agentWallet: body.agentWallet,
    });
    if (!consumed.ok) {
      return agentError(
        401,
        "NONCE_INVALID",
        "Challenge is invalid, expired or already used",
      );
    }

    const agent = await findAgentByWallet(body.agentWallet);
    if (!agent) {
      return agentError(401, "AGENT_UNKNOWN", "This agent is not registered");
    }
    if (agent.status !== "active") {
      return agentError(403, "AGENT_REVOKED", "This agent is not active");
    }

    const session = await issueAgentSession({
      agentId: agent.id,
      agentWallet: agent.agentWallet,
    });

    return agentOk({
      token: session.token,
      expiresIn: session.expiresIn,
      agentId: agent.id,
      rewardWallet: agent.rewardWallet,
    });
  },
});
