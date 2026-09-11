import { encodeFunctionData } from "viem";
import {
  checkErc20ApprovalForPermit2,
  checkPermit2Allowance,
} from "@/lib/uniswap/permit2";
import { PERMIT2_ABI } from "@/lib/uniswap/abi/permit2";
import { ERC20_ABI } from "@/lib/blockchain/shared/abi-definitions";
import { UNISWAP_ADDRESSES } from "@/lib/uniswap/constants";
import type { ActionContext } from "./actions/types";
import type { AgentWallet } from "./wallet";

const PERMIT2_EXPIRY_SECONDS = 30 * 60;

export interface ApprovalStep {
  step: "erc20-permit2" | "permit2-router" | "erc20-spender";
  txHash: `0x${string}`;
}

/**
 * Ensure the agent can sell `tokenIn` through the Universal Router.
 *
 * Native ETH needs nothing. Every other token needs the two-step Permit2 dance
 * — ERC20.approve(Permit2), then Permit2.approve(UniversalRouter) — which is
 * why sell-direction quests failed outright before this existed. Both are
 * one-time per token, so a warm agent skips straight through.
 */
export async function ensureSwapApprovals(
  wallet: AgentWallet,
  tokenIn: `0x${string}`,
  amountIn: bigint,
  isNativeEthIn: boolean,
  onApproval?: ActionContext["onApprovalTransaction"],
): Promise<ApprovalStep[]> {
  if (isNativeEthIn) return [];

  const permit2 = UNISWAP_ADDRESSES.permit2 as `0x${string}`;
  const router = UNISWAP_ADDRESSES.universalRouter as `0x${string}`;
  const owner = wallet.address as `0x${string}`;
  const steps: ApprovalStep[] = [];

  const erc20Allowance = await checkErc20ApprovalForPermit2(
    wallet.publicClient,
    tokenIn,
    owner,
    permit2,
  );

  if (erc20Allowance < amountIn) {
    if (erc20Allowance > 0n) {
      throw new Error("APPROVAL_RESET_REQUIRED");
    }
    await onApproval?.({ step: "erc20-permit2" });
    const txHash = await wallet.sendTransaction({
      to: tokenIn,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [permit2, amountIn],
      }),
    });
    await onApproval?.({ step: "erc20-permit2", txHash });
    const receipt = await wallet.waitForReceipt(txHash);
    if (receipt.status !== "success") {
      throw new Error(`ERC20 approval for Permit2 reverted (${txHash})`);
    }
    steps.push({ step: "erc20-permit2", txHash });
  }

  const permit2Allowance = await checkPermit2Allowance(
    wallet.publicClient,
    permit2,
    owner,
    tokenIn,
    router,
  );

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresSoon = permit2Allowance.expiration < nowSeconds + 60;

  if (permit2Allowance.amount < amountIn || expiresSoon) {
    if (amountIn >= 1n << 160n) {
      throw new Error("APPROVAL_AMOUNT_OUT_OF_RANGE");
    }
    await onApproval?.({ step: "permit2-router" });
    const txHash = await wallet.sendTransaction({
      to: permit2,
      data: encodeFunctionData({
        abi: PERMIT2_ABI,
        functionName: "approve",
        args: [tokenIn, router, amountIn, nowSeconds + PERMIT2_EXPIRY_SECONDS],
      }),
    });
    await onApproval?.({ step: "permit2-router", txHash });
    const receipt = await wallet.waitForReceipt(txHash);
    if (receipt.status !== "success") {
      throw new Error(`Permit2 router approval reverted (${txHash})`);
    }
    steps.push({ step: "permit2-router", txHash });
  }

  return steps;
}

/**
 * Ensure `spender` may pull `amount` of `token` from the agent.
 *
 * Plain ERC-20, not the Permit2 dance above: the DG vendor pulls directly, so
 * the two-step router flow does not apply to it.
 */
export async function ensureErc20Allowance(
  wallet: AgentWallet,
  token: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint,
  onApproval?: ActionContext["onApprovalTransaction"],
): Promise<ApprovalStep[]> {
  const allowance = (await wallet.publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [wallet.address, spender],
  })) as bigint;

  if (allowance >= amount) return [];
  if (allowance > 0n) {
    throw new Error("APPROVAL_RESET_REQUIRED");
  }

  await onApproval?.({ step: "erc20-spender" });
  const txHash = await wallet.sendTransaction({
    to: token,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
        args: [spender, amount],
    }),
  });
  await onApproval?.({ step: "erc20-spender", txHash });
  const receipt = await wallet.waitForReceipt(txHash);
  if (receipt.status !== "success") {
    throw new Error(`Token approval reverted for ${token}`);
  }

  return [{ step: "erc20-spender", txHash }];
}
