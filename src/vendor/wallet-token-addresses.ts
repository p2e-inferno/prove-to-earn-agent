import { CURRENT_NETWORK } from "@vendor/blockchain/frontend-config";
import { type Address, getAddress, isAddress } from "viem";

const DEFAULT_BASE_MAINNET_TOKEN_ADDRESSES = {
  dg: "0x4aA47eD29959c7053996d8f7918db01A62D02ee5" as Address,
  up: "0xaC27fa800955849d6D17cC8952Ba9dD6EAA66187" as Address,
} as const;

function normalizeAddress(raw?: string, fallback?: Address): Address | undefined {
  if (!raw) return fallback;

  const trimmed = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return fallback;

  if (isAddress(trimmed)) {
    return getAddress(trimmed);
  }

  return fallback;
}

export function getBaseMainnetTokenAddresses() {
  return {
    dg: normalizeAddress(
      process.env.NEXT_PUBLIC_DG_TOKEN_ADDRESS_BASE_MAINNET,
      DEFAULT_BASE_MAINNET_TOKEN_ADDRESSES.dg,
    ),
    up: normalizeAddress(
      process.env.NEXT_PUBLIC_UP_TOKEN_ADDRESS_BASE_MAINNET,
      DEFAULT_BASE_MAINNET_TOKEN_ADDRESSES.up,
    ),
  };
}

export function getWalletTransferTokenAddresses() {
  const baseMainnetTokens = getBaseMainnetTokenAddresses();

  return {
    usdc: CURRENT_NETWORK.usdcAddress as Address,
    // DG and UP intentionally stay on Base Mainnet to match wallet balance behavior.
    dg: baseMainnetTokens.dg,
    up: baseMainnetTokens.up,
  };
}
