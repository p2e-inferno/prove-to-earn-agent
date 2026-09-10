import { NextResponse, type NextRequest } from "next/server";
import {
  createPublicClient,
  formatEther,
  formatUnits,
  http,
  isAddress,
} from "viem";
import { base } from "viem/chains";
import { ERC20_ABI } from "@/lib/blockchain/shared/abi-definitions";
import { UNISWAP_ADDRESSES } from "@/lib/uniswap/constants";
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

    const client = createPublicClient({
      chain: base,
      transport: http(process.env.NEXT_PUBLIC_BASE_MAINNET_RPC_URL),
    });
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
        ETH: { raw: eth.toString(), formatted: formatEther(eth) },
        USDC: { raw: usdc.toString(), formatted: formatUnits(usdc, 6) },
      },
    });
  },
});
