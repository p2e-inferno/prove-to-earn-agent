/**
 * Lean reimplementation of the private platform's RPC provider selection
 * (`lib/blockchain/config/` — ~1600 lines of sequential-failover transport,
 * chain resolution and browser-specific endpoint reordering). This is
 * infrastructure a host configures with their own provider keys anyway, not
 * proprietary logic, so rather than vendor the whole subsystem this ships a
 * smaller, self-contained equivalent: env-driven RPC URLs with viem's
 * built-in `fallback()` transport. It does not reproduce the original's
 * sequential-retry-with-backoff transport or its RPC error classification.
 *
 * Uniswap routing/fee logic is vendored exactly, unlike this file — see
 * `src/vendor/uniswap/`.
 */
export const BASE_MAINNET_CHAIN_ID = 8453;
export const BASE_SEPOLIA_CHAIN_ID = 84532;

const PUBLIC_RPC_FALLBACKS: Record<number, string[]> = {
  [BASE_MAINNET_CHAIN_ID]: ["https://mainnet.base.org"],
  [BASE_SEPOLIA_CHAIN_ID]: ["https://sepolia.base.org"],
};

export function getClientRpcUrls(targetChainId: number = BASE_MAINNET_CHAIN_ID): string[] {
  const urls: string[] = [];
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  const infuraKey = process.env.INFURA_API_KEY;
  const customUrl = process.env.AGENT_RPC_URL;

  if (customUrl) urls.push(customUrl);
  if (alchemyKey && targetChainId === BASE_MAINNET_CHAIN_ID) {
    urls.push(`https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`);
  }
  if (alchemyKey && targetChainId === BASE_SEPOLIA_CHAIN_ID) {
    urls.push(`https://base-sepolia.g.alchemy.com/v2/${alchemyKey}`);
  }
  if (infuraKey && targetChainId === BASE_MAINNET_CHAIN_ID) {
    urls.push(`https://base-mainnet.infura.io/v3/${infuraKey}`);
  }
  urls.push(...(PUBLIC_RPC_FALLBACKS[targetChainId] ?? []));
  return urls;
}
