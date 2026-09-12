import { NextResponse, type NextRequest } from "next/server";
import { isAddress } from "viem";
import { base } from "viem/chains";
import { ERC20_ABI } from "@vendor/blockchain/abi-definitions";
import { createPublicClientForNetwork } from "@vendor/blockchain/public-client";
import { UNISWAP_ADDRESSES } from "@vendor/uniswap/constants";
import { assetAmount } from "@/packages/agent-runner/src/actions/types";
import { findOwnedAgent } from "../../db/agents";
import { agentError, agentOk } from "../../errors";
import { createPairingRoute } from "../../route-factory";

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
    if (!params.agentId)
      return agentError(400, "INVALID_REQUEST", "Missing agentId");
    const agent = await findOwnedAgent(params.agentId, ownerUserId);
    if (!agent) return agentError(404, "AGENT_UNKNOWN", "Agent not found");
    if (!agent.agentWallet || !isAddress(agent.agentWallet)) {
      return agentError(409, "AGENT_NOT_READY", "Agent wallet is not ready");
    }

    const client = createPublicClientForNetwork({ chainId: base.id });
    const address = agent.agentWallet as `0x${string}`;
    const [eth, usdc] = await Promise.all([
      client.getBalance({ address }),
      client.readContract({
        address: UNISWAP_ADDRESSES.usdc,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [address],
      }) as Promise<bigint>,
    ]);
    return agentOk({
      agentId: agent.id,
      network: "Base mainnet",
      balances: {
        ETH: assetAmount("ETH", eth, 18, null),
        USDC: assetAmount("USDC", usdc, 6, UNISWAP_ADDRESSES.usdc),
      },
    });
  },
});
