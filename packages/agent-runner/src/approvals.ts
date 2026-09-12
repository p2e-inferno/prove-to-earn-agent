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

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

/** Re-approve before the allowance is close enough to expire mid-swap. */
const EXPIRY_BUFFER_SECONDS = 3600;

export interface ApprovalStep {
  step:
    | "erc20-permit2"
    | "erc20-permit2-reset"
    | "permit2-router"
    | "erc20-spender"
    | "erc20-spender-reset";
  txHash: `0x${string}`;
}

/**
 * Known-spender approvals are granted at maximum once and reused across every
 * later run (quests run daily against the same registered integration), so a
 * pre-existing allowance is normally either 0 (never approved) or already the
 * max (already approved) — never a smaller nonzero value. The one exception
 * is a wallet left with a smaller exact allowance from before the agent used
 * reusable max approvals; most ERC-20s refuse to raise a nonzero allowance
 * directly (the classic approve-race guard), so that legacy value must be
 * reset to zero first. This is a one-time compatibility path, not part of
 * the normal per-run flow, and is reported as its own auditable step via
 * `onApproval` rather than folded into the max approval that follows it.
 */
async function resetErc20Allowance(
  wallet: AgentWallet,
  token: `0x${string}`,
  spender: `0x${string}`,
  step: "erc20-permit2-reset" | "erc20-spender-reset",
  onApproval?: ActionContext["onApprovalTransaction"],
): Promise<ApprovalStep> {
  await onApproval?.({ step });
  const txHash = await wallet.sendTransaction({
    to: token,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, 0n],
    }),
  });
  await onApproval?.({ step, txHash });
  const receipt = await wallet.waitForReceipt(txHash);
  if (receipt.status !== "success") {
    throw new Error(`Allowance reset reverted for ${token} (${txHash})`);
  }
  return { step, txHash };
}

/**
 * Ensure the agent can sell `tokenIn` through the Universal Router.
 *
 * Native ETH needs nothing. Every other token needs the two-step Permit2 dance
 * — ERC20.approve(Permit2), then Permit2.approve(UniversalRouter) — which is
 * why sell-direction quests failed outright before this existed. Both grant a
 * reusable maximum allowance against the platform's own registered Permit2
 * and Universal Router addresses (never a client-supplied spender), so a
 * warm agent skips straight through on every later run.
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
      steps.push(
        await resetErc20Allowance(
          wallet,
          tokenIn,
          permit2,
          "erc20-permit2-reset",
          onApproval,
        ),
      );
    }
    await onApproval?.({ step: "erc20-permit2" });
    const txHash = await wallet.sendTransaction({
      to: tokenIn,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [permit2, MAX_UINT256],
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
  const expiresSoon =
    permit2Allowance.expiration < nowSeconds + EXPIRY_BUFFER_SECONDS;

  if (permit2Allowance.amount < amountIn || expiresSoon) {
    await onApproval?.({ step: "permit2-router" });
    const txHash = await wallet.sendTransaction({
      to: permit2,
      data: encodeFunctionData({
        abi: PERMIT2_ABI,
        functionName: "approve",
        args: [tokenIn, router, MAX_UINT160, Number(MAX_UINT48)],
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
 * the two-step router flow does not apply to it. Grants a reusable maximum
 * allowance for the same repeated-spender reason as above; `spender` is
 * always a server-registered address from the caller's action config, never
 * client-supplied.
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
  const steps: ApprovalStep[] = [];
  if (allowance > 0n) {
    steps.push(
      await resetErc20Allowance(
        wallet,
        token,
        spender,
        "erc20-spender-reset",
        onApproval,
      ),
    );
  }

  await onApproval?.({ step: "erc20-spender" });
  const txHash = await wallet.sendTransaction({
    to: token,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, MAX_UINT256],
    }),
  });
  await onApproval?.({ step: "erc20-spender", txHash });
  const receipt = await wallet.waitForReceipt(txHash);
  if (receipt.status !== "success") {
    throw new Error(`Token approval reverted for ${token}`);
  }

  steps.push({ step: "erc20-spender", txHash });
  return steps;
}
