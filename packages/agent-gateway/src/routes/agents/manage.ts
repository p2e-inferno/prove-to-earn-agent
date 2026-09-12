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
  updateAgentPermissions,
  updatePlatformAgent,
  type AgentCapability,
  type RegisteredAgent,
  type TemplateScope,
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

const templateScopeSchema = z.enum([
  "all",
  "selected",
  "none",
]) satisfies z.ZodType<TemplateScope>;

const templateScopeFields = {
  // ALL/SELECTED/NONE is an explicit choice, never inferred from whether
  // templateIds happens to be empty — an empty array under "selected" is
  // rejected below rather than silently read back as "all" or "none".
  templateScope: templateScopeSchema,
  templateIds: z.array(z.string().uuid()).max(100).default([]),
};

const createSchema = z
  .object({
    displayName: z.string().trim().min(2).max(40),
    rewardWallet: z.string().refine(ethers.isAddress),
    capabilities: z.array(z.enum(capabilities)).min(1),
    ...templateScopeFields,
    maxFundingSwaps: z.number().int().min(0).max(32).nullable().default(null),
  })
  .strict()
  .refine(
    (value) =>
      value.templateScope !== "selected" || value.templateIds.length > 0,
    {
      message: "Select at least one template, or choose All or None",
      path: ["templateIds"],
    },
  );

const permissionsUpdateSchema = z
  .object({
    capabilities: z.array(z.enum(capabilities)).min(1),
    ...templateScopeFields,
  })
  .strict()
  .refine(
    (value) =>
      value.templateScope !== "selected" || value.templateIds.length > 0,
    {
      message: "Select at least one template, or choose All or None",
      path: ["templateIds"],
    },
  );

const updateSchema = z
  .object({
    displayName: z.string().trim().min(2).max(40).optional(),
    maxFundingSwaps: z.number().int().min(0).max(32).nullable().optional(),
    permissions: permissionsUpdateSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.displayName !== undefined ||
      value.maxFundingSwaps !== undefined ||
      value.permissions !== undefined,
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
      templateScope: parsed.data.templateScope,
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

    let updated: RegisteredAgent | null = null;
    if (
      parsed.data.displayName !== undefined ||
      parsed.data.maxFundingSwaps !== undefined
    ) {
      updated = await updatePlatformAgent(params.agentId, ownerUserId, {
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
    }
    if (parsed.data.permissions) {
      updated = await updateAgentPermissions(params.agentId, ownerUserId, {
        capabilities: parsed.data.permissions.capabilities,
        templateScope: parsed.data.permissions.templateScope,
        templateIds: parsed.data.permissions.templateIds,
      });
      if (!updated) {
        return agentError(
          409,
          "AGENT_PERMISSIONS_UPDATE_CONFLICT",
          "Agent not found, revoked, or its settings changed concurrently",
        );
      }
    }
    return agentOk({ agent: publicAgent(updated!) });
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
