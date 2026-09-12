/**
 * Permit2 approval helpers for the Uniswap Universal Router.
 *
 * Two-step approval flow:
 * 1. ERC20.approve(Permit2, MAX_UINT256) — one-time per token
 * 2. Permit2.approve(UniversalRouter, MAX_UINT160, MAX_UINT48) — one-time per token
 */

import type { PublicClient, WalletClient } from "viem";
import { PERMIT2_ABI } from "./abi/permit2";
import { ERC20_ABI } from "@vendor/blockchain/abi-definitions";

// ERC20.approve uses uint256 — standard max approval for the ERC20->Permit2 step.
// Permit2.approve uses uint160 for the allowance amount and uint48 for expiration.
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

/**
 * Check if the user has approved the Permit2 contract for a given token
 */
export async function checkErc20ApprovalForPermit2(
  publicClient: PublicClient,
  tokenAddress: `0x${string}`,
  ownerAddress: `0x${string}`,
  permit2Address: `0x${string}`,
): Promise<bigint> {
  return publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [ownerAddress, permit2Address],
  }) as Promise<bigint>;
}

/**
 * Check if Permit2 has granted allowance to the Universal Router
 */
export async function checkPermit2Allowance(
  publicClient: PublicClient,
  permit2Address: `0x${string}`,
  ownerAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  spenderAddress: `0x${string}`,
): Promise<{ amount: bigint; expiration: number; nonce: number }> {
  const result = await publicClient.readContract({
    address: permit2Address,
    abi: PERMIT2_ABI,
    functionName: "allowance",
    args: [ownerAddress, tokenAddress, spenderAddress],
  });
  const [amount, expiration, nonce] = result as [bigint, number, number];
  return { amount, expiration, nonce };
}

/**
 * Approve Permit2 to spend user's tokens (one-time per token).
 * Uses MAX_UINT256 (standard ERC20 max approval).
 */
export async function approveTokenForPermit2(
  walletClient: WalletClient,
  tokenAddress: `0x${string}`,
  permit2Address: `0x${string}`,
): Promise<`0x${string}`> {
  return walletClient.writeContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [permit2Address, MAX_UINT256],
    chain: walletClient.chain,
    account: walletClient.account!,
  });
}

/**
 * Grant Permit2 allowance for the Universal Router to pull tokens.
 * Uses MAX_UINT160 amount and MAX_UINT48 expiration so this is a one-time
 * approval — subsequent swaps of any size will not require re-approval.
 */
export async function approveUniversalRouterViaPermit2(
  walletClient: WalletClient,
  permit2Address: `0x${string}`,
  tokenAddress: `0x${string}`,
  routerAddress: `0x${string}`,
): Promise<`0x${string}`> {
  return walletClient.writeContract({
    address: permit2Address,
    abi: PERMIT2_ABI,
    functionName: "approve",
    args: [tokenAddress, routerAddress, MAX_UINT160, Number(MAX_UINT48)],
    chain: walletClient.chain,
    account: walletClient.account!,
  });
}
