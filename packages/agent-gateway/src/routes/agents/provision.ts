import { NextResponse, type NextRequest } from "next/server";
import { inngest } from "@/lib/inngest/client";
import { createAgentAdminClient } from "@/lib/supabase/agent-schema";
import { findOwnedAgent } from "../../db/agents";
import { agentError, agentOk } from "../../errors";
import { createPairingRoute } from "../../route-factory";

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
    if (!params.agentId) {
      return agentError(400, "INVALID_REQUEST", "Missing agentId");
    }

    const supabase = createAgentAdminClient();
    const agent = await findOwnedAgent(params.agentId, ownerUserId);
    if (!agent) {
      return agentError(
        404,
        "AGENT_UNKNOWN",
        "Agent not found for this account",
      );
    }
    if (agent.agentWallet) {
      return agentOk({ agentId: agent.id, status: "ready" });
    }
    if (
      agent.status !== "provisioning_wallet" &&
      agent.status !== "provisioning_failed"
    ) {
      return agentError(409, "AGENT_NOT_PROVISIONABLE", "Agent cannot retry");
    }

    const nextVersion = agent.lifecycleVersion + 1;
    const { data: resetData, error: resetError } = await supabase.rpc(
      "transition_platform_agent_provisioning",
      {
        p_agent_id: agent.id,
        p_owner_user_id: ownerUserId,
        p_status: "provisioning_wallet",
        p_error_code: null,
        p_expected_version: agent.lifecycleVersion,
      },
    );
    if (resetError) throw resetError;
    const reset = (resetData ?? {}) as Record<string, unknown>;
    if (reset.success !== true) {
      return agentError(
        409,
        "AGENT_STATE_CONFLICT",
        "Agent state changed; retry",
      );
    }

    try {
      await inngest.send({
        id: `agent-provision-retry-${agent.id}-${nextVersion}`,
        name: "agent/provision.requested",
        data: { agentId: agent.id },
      });
    } catch {
      await supabase.rpc("transition_platform_agent_provisioning", {
        p_agent_id: agent.id,
        p_owner_user_id: ownerUserId,
        p_status: "provisioning_failed",
        p_error_code: "PROVISIONING_QUEUE_UNAVAILABLE",
        p_expected_version: nextVersion,
      });
      return agentError(
        503,
        "PROVISIONING_QUEUE_UNAVAILABLE",
        "Wallet provisioning could not be queued; try again",
      );
    }
    return agentOk({ agentId: agent.id, status: "provisioning_wallet" }, 202);
  },
});
