/**
 * Frontend blockchain configuration
 * This file contains hardcoded values for frontend use to avoid
 * exposing backend environment variables to the browser
 */

export type NetworkType = "base" | "base-sepolia";

export interface NetworkConfig {
  name: NetworkType;
  displayName: string;
  rpcUrl: string;
  chainId: number;
  usdcAddress: string;
  explorerUrl: string;
}

// Network configurations with hardcoded values
export const NETWORK_CONFIGS: Record<NetworkType, NetworkConfig> = {
  base: {
    name: "base",
    displayName: "Base Mainnet",
    rpcUrl: "https://mainnet.base.org",
    chainId: 8453,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    explorerUrl: "https://basescan.org",
  },
  "base-sepolia": {
    name: "base-sepolia",
    displayName: "Base Sepolia",
    rpcUrl: "https://sepolia.base.org",
    chainId: 84532,
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorerUrl: "https://sepolia.basescan.org",
  },
};

// Default network (should match backend configuration)
export const DEFAULT_NETWORK: NetworkType = (process.env
  .NEXT_PUBLIC_BLOCKCHAIN_NETWORK || "base-sepolia") as NetworkType;

// Get current network configuration
export const getCurrentNetworkConfig = (): NetworkConfig => {
  // For now, we'll use the default network
  // In the future, this could be made dynamic based on user selection or other factors
  return NETWORK_CONFIGS[DEFAULT_NETWORK];
};

// Export current network info for convenience
export const CURRENT_NETWORK = getCurrentNetworkConfig();

// ERC20 ABI for token operations (commonly needed)
export const ERC20_ABI = [
  {
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "name",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
