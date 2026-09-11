import { NextResponse, type NextRequest } from "next/server";
import { ethers } from "ethers";
import { z } from "zod";
import { getUserWalletAddresses } from "@/lib/auth/privy";
import { resolveSafeLinkedWalletCandidates } from "@/lib/auth/filter-mapped-linked-wallet";
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/server";
import { createAgentAdminClient } from "@/lib/supabase/agent-schema";
import { getLogger } from "@/lib/utils/logger";
import { agentError, agentOk } from "../../errors";
import {
  agentCapacityForOwner,
  createPlatformAgent,
  listAgentsPageForOwner,
  revokeAgent,
  updatePlatformAgent,
  type AgentCapability,
  type RegisteredAgent,
} from "../../db/agents";
import { agentOwnerLimit } from "../../env";
import { createPairingRoute } from "../../route-factory";

const log = getLogger("agent-gateway:routes:agents");

const capabilities = [
  "quests.read",
  "quests.start",
  "tasks.complete",
  "tasks.claim",
  "quests.complete",
] as const satisfies readonly AgentCapability[];

const createSchema = z
  .object({
    displayName: z.string().trim().min(2).max(40),
    rewardWallet: z.string().refine(ethers.isAddress),
    capabilities: z.array(z.enum(capabilities)).min(1),
    templateIds: z.array(z.string().uuid()).max(100).default([]),
    maxFundingSwaps: z.number().int().min(0).max(32).nullable().default(null),
  })
  .strict();

const updateSchema = z
  .object({
    displayName: z.string().trim().min(2).max(40).optional(),
    maxFundingSwaps: z.number().int().min(0).max(32).nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.displayName !== undefined || value.maxFundingSwaps !== undefined,
  );

export function publicAgent(
  agent: RegisteredAgent & { permissions?: unknown },
) {
  return {
    id: agent.id,
    displayName: agent.displayName,
    agentWallet: agent.agentWallet,
    rewardWallet: agent.rewardWallet,
    status: agent.status,
    executionMode: agent.executionMode,
    maxFundingSwaps: agent.maxFundingSwaps,
    worldStatus: agent.worldStatus,
    worldVerified: agent.worldStatus === "verified",
    worldVerifiedAt: agent.worldVerifiedAt,
    readyAt: agent.readyAt,
    revokedAt: agent.revokedAt,
    ...(agent.permissions ? { permissions: agent.permissions } : {}),
  };
}

async function verifyRewardWallet(
  ownerUserId: string,
  rewardWallet: string,
): Promise<boolean> {
  const safeWallets = await resolveSafeLinkedWalletCandidates({
    supabase: createAdminClient(),
    privyUserId: ownerUserId,
    linkedWallets: await getUserWalletAddresses(ownerUserId, {
      allowEmptyOnError: false,
    }),
  });
  return safeWallets.some(
    (wallet) => wallet.toLowerCase() === rewardWallet.toLowerCase(),
  );
}

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
    const limit = agentOwnerLimit();
    const requestedLimit = Number(_req.nextUrl.searchParams.get("limit") ?? 20);
    const pageLimit = Number.isInteger(requestedLimit)
      ? Math.min(50, Math.max(1, requestedLimit))
      : 20;
    const cursor = _req.nextUrl.searchParams.get("cursor");
    if (cursor && !z.string().uuid().safeParse(cursor).success) {
      return agentError(400, "INVALID_CURSOR", "Invalid agent cursor");
    }
    const [page, capacity] = await Promise.all([
      listAgentsPageForOwner(ownerUserId, { limit: pageLimit, cursor }),
      agentCapacityForOwner(ownerUserId, limit),
    ]);
    return agentOk({
      agents: page.agents.map(publicAgent),
      capacity,
      nextCursor: page.nextCursor,
    });
  },
});

export const CREATE = createPairingRoute({
  guard: "owner-privy-session",
  handler: async (
    req: NextRequest,
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

    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return agentError(400, "INVALID_REQUEST", "Invalid agent settings");
    }

    let ownsRewardWallet: boolean;
    try {
      ownsRewardWallet = await verifyRewardWallet(
        ownerUserId,
        parsed.data.rewardWallet,
      );
    } catch (error) {
      log.error("Failed to resolve wallets during agent creation", { error });
      return agentError(
        503,
        "OWNER_WALLETS_UNAVAILABLE",
        "Could not verify your reward wallet",
      );
    }
    if (!ownsRewardWallet) {
      return agentError(
        403,
        "REWARD_WALLET_NOT_OWNED",
        "The reward wallet must be one of your linked wallets",
      );
    }

    const result = await createPlatformAgent({
      ownerUserId,
      rewardWallet: parsed.data.rewardWallet,
      displayName: parsed.data.displayName,
      capabilities: parsed.data.capabilities,
      templateIds: parsed.data.templateIds,
      maxFundingSwaps: parsed.data.maxFundingSwaps,
      ownerLimit: agentOwnerLimit(),
    });

    if (!result.ok) {
      return agentError(
        result.code === "AGENT_CAPACITY_REACHED" ? 409 : 400,
        result.code,
        result.code === "AGENT_CAPACITY_REACHED"
          ? "This account has reached its current agent limit"
          : "The agent could not be created",
      );
    }

    let agent = result.agent;
    try {
      await inngest.send({
        id: `agent-provision-${result.agent.id}`,
        name: "agent/provision.requested",
        data: { agentId: result.agent.id },
      });
    } catch (error) {
      log.error("Failed to enqueue agent provisioning", {
        agentId: result.agent.id,
        error,
      });
      const { data } = await createAgentAdminClient().rpc(
        "transition_platform_agent_provisioning",
        {
          p_agent_id: result.agent.id,
          p_owner_user_id: ownerUserId,
          p_status: "provisioning_failed",
          p_error_code: "PROVISIONING_QUEUE_UNAVAILABLE",
          p_expected_version: result.agent.lifecycleVersion,
        },
      );
      // Returning the pre-transition row would tell the client the agent is
      // still provisioning when nothing is queued to provision it.
      if ((data as Record<string, unknown> | null)?.success === true) {
        agent = { ...agent, status: "provisioning_failed" };
      }
    }

    return agentOk(
      { agent: publicAgent(agent), capacity: result.capacity },
      202,
    );
  },
});

export const PATCH = createPairingRoute({
  guard: "owner-privy-session",
  handler: async (
    req: NextRequest,
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

    const parsed = updateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return agentError(400, "INVALID_REQUEST", "Invalid agent settings");
    }

    const updated = await updatePlatformAgent(params.agentId, ownerUserId, {
      displayName: parsed.data.displayName,
      maxFundingSwaps: parsed.data.maxFundingSwaps,
    });
    if (!updated) {
      return agentError(
        404,
        "AGENT_UNKNOWN",
        "Agent not found for this account",
      );
    }
    return agentOk({ agent: publicAgent(updated) });
  },
});

export const REVOKE = createPairingRoute({
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

    const revoked = await revokeAgent(params.agentId, ownerUserId);
    if (!revoked) {
      return agentError(
        404,
        "AGENT_UNKNOWN",
        "Agent not found for this account",
      );
    }
    return agentOk({ agentId: params.agentId, status: "revoked" });
  },
});
