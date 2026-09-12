/**
 * Lean reimplementation of `createPublicClientUnified` /
 * `createPublicClientForNetwork` — see `rpc-config.ts` for why this is a
 * simplification rather than a vendor-verbatim copy.
 */
import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { getClientRpcUrls, BASE_MAINNET_CHAIN_ID } from "./rpc-config";

const CHAINS: Record<number, typeof base> = {
  [base.id]: base,
  [baseSepolia.id]: baseSepolia as unknown as typeof base,
};

let cachedClient: PublicClient | null = null;

export function createPublicClientUnified(): PublicClient {
  if (cachedClient) return cachedClient;
  cachedClient = createPublicClientForNetwork({ chainId: BASE_MAINNET_CHAIN_ID });
  return cachedClient;
}

export function createPublicClientForNetwork(networkConfig: {
  chainId: number;
  rpcUrl?: string | null;
}): PublicClient {
  const chain = CHAINS[networkConfig.chainId];
  if (!chain) {
    throw new Error(`Unsupported chainId for public client: ${networkConfig.chainId}`);
  }
  const urls = networkConfig.rpcUrl
    ? [networkConfig.rpcUrl]
    : getClientRpcUrls(networkConfig.chainId);
  if (urls.length === 0) {
    throw new Error(`No RPC URL configured for chainId ${networkConfig.chainId}`);
  }
  // Cast: the workspace resolves more than one copy of viem's types (agent-gateway
  // and agent-runner each pin their own range), so structurally-identical client
  // types are sometimes seen as nominally distinct across package boundaries.
  return createPublicClient({
    chain,
    transport: fallback(urls.map((u) => http(u))),
  }) as unknown as PublicClient;
}
