import { NextResponse, type NextRequest } from "next/server";
import { ethers } from "ethers";
import { createAgentBookVerifier } from "@worldcoin/agentkit-core";
import { createAgentAdminClient } from "@adapters/datastore";
import { getLogger } from "@vendor/logger";
import { agentError, agentOk } from "../../errors";
import { loadStoredGrant, recoverGrantSigner } from "../../auth/grant";
import { createPairingRoute } from "../../route-factory";
import { worldChainRpcUrl } from "../../env";

const log = getLogger("agent-gateway:routes:register:create");

type Body = { nonce?: string; agentSignature?: string; label?: string };

/**
 * AgentBook proves a verified human backs this agent. It does NOT prove that
 * human is the P2E owner registering it, so the id is stored as a sybil signal
 * and nothing more.
 */
async function lookupAgentbookHuman(
  agentWallet: string,
): Promise<string | null> {
  try {
    const rpcUrl = worldChainRpcUrl();
    const agentBook = createAgentBookVerifier(rpcUrl ? { rpcUrl } : undefined);
    const humanId = await agentBook.lookupHuman(agentWallet);
    return humanId ?? null;
  } catch (error) {
    log.warn("AgentBook lookup failed; registering without a human id", {
      error,
    });
    return null;
  }
}

export const POST = createPairingRoute({
  guard: "owner-or-agent-signature",
  handler: async (req: NextRequest): Promise<NextResponse> => {
    if (process.env.NODE_ENV === "production") {
      return agentError(
        403,
        "LEGACY_REGISTRATION_DISABLED",
        "Create a hosted agent from the agent workspace",
      );
    }

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return agentError(400, "INVALID_REQUEST", "A JSON body is required");
    }

    if (!body.nonce || !body.agentSignature) {
      return agentError(
        400,
        "INVALID_REQUEST",
        "nonce and agentSignature are required",
      );
    }

    const stored = await loadStoredGrant(body.nonce);
    if (!stored) {
      return agentError(400, "NONCE_INVALID", "Registration grant not found");
    }
    if (stored.consumed) {
      return agentError(
        400,
        "NONCE_INVALID",
        "This registration grant was already used",
      );
    }
    if (stored.expired) {
      return agentError(
        400,
        "GRANT_EXPIRED",
        "This registration grant has expired",
      );
    }

    // Recovered against the server-stored grant, never a client-supplied one:
    // that is what makes payload substitution impossible.
    const signer = recoverGrantSigner(stored.grant, body.agentSignature);
    if (!signer || signer.toLowerCase() !== stored.agentWallet.toLowerCase()) {
      return agentError(
        400,
        "SIGNATURE_INVALID",
        "Grant signature does not match the agent wallet",
      );
    }

    const agentbookHumanId = await lookupAgentbookHuman(stored.agentWallet);

    const capabilities = stored.grant.capabilities
      ? stored.grant.capabilities.split(",").filter(Boolean)
      : [];
    const templateIds = stored.grant.templateIds
      ? stored.grant.templateIds.split(",").filter(Boolean)
      : [];

    const supabase = createAgentAdminClient();
    const { data, error } = await supabase.rpc("register_agent", {
      p_nonce: body.nonce,
      p_owner_user_id: stored.ownerUserId,
      p_agent_wallet: stored.agentWallet,
      p_reward_wallet: ethers
        .getAddress(stored.grant.rewardWallet)
        .toLowerCase(),
      p_label: body.label ?? "agent",
      p_agentbook_human_id: agentbookHumanId,
      p_capabilities: capabilities,
      p_template_ids: templateIds.length ? templateIds : null,
    });

    if (error) {
      log.error("register_agent RPC failed", { error });
      return agentError(500, "INTERNAL_ERROR", "Failed to register the agent");
    }

    const row = (data ?? {}) as Record<string, unknown>;
    if (row.success !== true) {
      const code = String(row.error ?? "GRANT_INVALID");
      const status = code === "AGENT_ALREADY_REGISTERED" ? 409 : 400;
      return agentError(status, code, "Registration was rejected");
    }

    return agentOk({
      agentId: String(row.agent_id),
      agentWallet: stored.agentWallet,
      rewardWallet: stored.grant.rewardWallet,
      capabilities,
      templateIds,
      status: "ready",
    });
  },
});
