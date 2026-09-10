import { NextResponse, type NextRequest } from "next/server";
import { getUserWalletAddresses } from "@/lib/auth/privy";
import { resolveSafeLinkedWalletCandidates } from "@/lib/auth/filter-mapped-linked-wallet";
import { createAdminClient } from "@/lib/supabase/server";
import { getLogger } from "@/lib/utils/logger";
import { ethers } from "ethers";
import { agentError, agentOk } from "../../errors";
import {
  issueAgentGrant,
  agentGrantDomain,
  AGENT_GRANT_TYPES,
} from "../../auth/grant";
import { createPairingRoute } from "../../route-factory";
import type { AgentCapability } from "../../db/agents";

const log = getLogger("agent-gateway:routes:register:grant");

const VALID_CAPABILITIES: AgentCapability[] = [
  "quests.read",
  "quests.start",
  "tasks.complete",
  "tasks.claim",
  "quests.complete",
];

type Body = {
  agentWallet?: string;
  rewardWallet?: string;
  capabilities?: string[];
  templateIds?: string[];
};

export const POST = createPairingRoute({
  guard: "owner-privy-session",
  handler: async (
    req: NextRequest,
    _params,
    ownerUserId: string | null,
  ): Promise<NextResponse> => {
    if (process.env.NODE_ENV === "production") {
      return agentError(
        403,
        "LEGACY_REGISTRATION_DISABLED",
        "Create a hosted agent from the agent workspace",
      );
    }

    if (!ownerUserId) {
      return agentError(
        401,
        "OWNER_AUTH_REQUIRED",
        "Owner authentication is required",
      );
    }

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
    if (!body.rewardWallet || !ethers.isAddress(body.rewardWallet)) {
      return agentError(
        400,
        "INVALID_REQUEST",
        "A valid rewardWallet is required",
      );
    }

    const capabilities = (body.capabilities ?? []).filter(
      (c): c is AgentCapability =>
        VALID_CAPABILITIES.includes(c as AgentCapability),
    );
    if (capabilities.length === 0) {
      return agentError(
        400,
        "INVALID_REQUEST",
        "At least one valid capability must be granted",
      );
    }

    // Validated once, here, so no later endpoint has to trust a payout address
    // supplied by the agent.
    let candidates: string[];
    try {
      candidates = await resolveSafeLinkedWalletCandidates({
        supabase: createAdminClient(),
        privyUserId: ownerUserId,
        linkedWallets: await getUserWalletAddresses(ownerUserId, {
          allowEmptyOnError: false,
        }),
      });
    } catch (error) {
      log.error("Failed to resolve owner wallets for agent grant", { error });
      return agentError(
        503,
        "OWNER_WALLETS_UNAVAILABLE",
        "Could not verify your wallets",
      );
    }

    const rewardWallet = body.rewardWallet.toLowerCase();
    if (!candidates.some((w) => w.toLowerCase() === rewardWallet)) {
      return agentError(
        403,
        "REWARD_WALLET_NOT_OWNED",
        "The reward wallet must be one of your linked wallets",
      );
    }

    if (body.agentWallet.toLowerCase() === rewardWallet) {
      return agentError(
        400,
        "INVALID_REQUEST",
        "The agent wallet and the reward wallet must be different addresses",
      );
    }

    const { grant, nonce, expiresAt } = await issueAgentGrant({
      ownerUserId,
      agentWallet: body.agentWallet,
      rewardWallet: body.rewardWallet,
      capabilities,
      templateIds: body.templateIds ?? [],
    });

    return agentOk({
      grant,
      nonce,
      expiresAt,
      typedData: {
        domain: agentGrantDomain(),
        types: AGENT_GRANT_TYPES,
        primaryType: "AgentGrant",
        message: grant,
      },
    });
  },
});
