import type { NextRequest } from "next/server";
import type { QuestPrincipal } from "@/lib/quests/principal";
import {
  findAgentByWallet,
  loadPermissions,
  type AgentPermission,
  type RegisteredAgent,
} from "../db/agents";
import { getBearerToken, verifyAgentSession } from "./session";

export interface AgentActor {
  agent: RegisteredAgent;
  permissions: AgentPermission[];
  principal: QuestPrincipal;
}

export type ActorResolution =
  | { ok: true; actor: AgentActor }
  | { ok: false; status: number; code: string; message: string };

/**
 * Resolve an agent bearer session into a quest principal.
 *
 * Status and permissions are read per request rather than baked into the token
 * so a revocation takes effect immediately instead of at token expiry.
 */
export async function resolveAgentActor(
  req: NextRequest,
): Promise<ActorResolution> {
  const token = getBearerToken(req);
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: "AGENT_SESSION_INVALID",
      message: "An agent session bearer token is required",
    };
  }

  const claims = await verifyAgentSession(token);
  if (!claims) {
    return {
      ok: false,
      status: 401,
      code: "AGENT_SESSION_INVALID",
      message: "Agent session is invalid or expired",
    };
  }

  const agent = await findAgentByWallet(claims.agentWallet);
  if (!agent || agent.id !== claims.agentId) {
    return {
      ok: false,
      status: 401,
      code: "AGENT_UNKNOWN",
      message: "This agent is not registered",
    };
  }

  if (agent.status === "revoked") {
    return {
      ok: false,
      status: 403,
      code: "AGENT_REVOKED",
      message: "This agent has been revoked by its owner",
    };
  }
  if (agent.status === "suspended") {
    return {
      ok: false,
      status: 403,
      code: "AGENT_SUSPENDED",
      message: "This agent is suspended",
    };
  }

  const permissions = await loadPermissions(agent.id);

  return {
    ok: true,
    actor: {
      agent,
      permissions,
      principal: {
        userId: agent.ownerUserId,
        executionWallet: agent.agentWallet,
        rewardWallet: agent.rewardWallet,
        actorKind: "agent",
        agentId: agent.id,
        agentbookHumanId: agent.agentbookHumanId ?? undefined,
      },
    },
  };
}
