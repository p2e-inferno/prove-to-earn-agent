/**
 * @jest-environment node
 */

import { ensureSwapApprovals, ensureErc20Allowance } from "./approvals";
import { UNISWAP_ADDRESSES } from "@/lib/uniswap/constants";
import type { AgentWallet } from "./wallet";

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

const TOKEN_IN = "0x1111111111111111111111111111111111111111" as const;
const SPENDER = "0x2222222222222222222222222222222222222222" as const;
const OWNER = "0x3333333333333333333333333333333333333333" as const;

interface WalletFixture {
  wallet: AgentWallet;
  sendTransaction: jest.Mock;
  waitForReceipt: jest.Mock;
}

/**
 * `readContract` distinguishes the ERC20 allowance read (address = token,
 * args[1] = spender) from the Permit2 allowance read (address = permit2,
 * returns a [amount, expiration, nonce] tuple) purely by call shape, the same
 * way the real `checkErc20ApprovalForPermit2`/`checkPermit2Allowance`
 * helpers do — no mocking of those helpers themselves.
 */
function makeWallet(
  state: {
    erc20Allowance?: bigint;
    permit2Allowance?: { amount: bigint; expiration: number; nonce: number };
    spenderAllowance?: bigint;
  } = {},
): WalletFixture {
  const sendTransaction = jest.fn(async () => "0xhash" as `0x${string}`);
  const waitForReceipt = jest.fn(async () => ({ status: "success" as const }));
  const readContract = jest.fn(
    async ({
      address,
      args,
    }: {
      address: string;
      args: readonly unknown[];
    }) => {
      if (address === UNISWAP_ADDRESSES.permit2) {
        const a = state.permit2Allowance ?? {
          amount: 0n,
          expiration: 0,
          nonce: 0,
        };
        return [a.amount, a.expiration, a.nonce];
      }
      if (args[1] === UNISWAP_ADDRESSES.permit2) {
        return state.erc20Allowance ?? 0n;
      }
      return state.spenderAllowance ?? 0n;
    },
  );
  const wallet = {
    address: OWNER,
    caip2: "eip155:8453",
    provider: "local",
    x402Signer: {} as never,
    publicClient: { readContract } as never,
    sendTransaction,
    signMessage: jest.fn(),
    signTypedData: jest.fn(),
    waitForReceipt,
  } as unknown as AgentWallet;
  return { wallet, sendTransaction, waitForReceipt };
}

function approveCall(sendTransaction: jest.Mock, index: number) {
  return sendTransaction.mock.calls[index]?.[0] as {
    to: string;
    data: string;
  };
}

describe("ensureSwapApprovals", () => {
  it("grants a reusable maximum allowance on first encounter with a spender", async () => {
    const { wallet, sendTransaction } = makeWallet();
    const steps = await ensureSwapApprovals(wallet, TOKEN_IN, 1_000n, false);

    expect(steps.map((s) => s.step)).toEqual([
      "erc20-permit2",
      "permit2-router",
    ]);
    // approve(permit2, MAX_UINT256)
    expect(approveCall(sendTransaction, 0).data).toContain(
      MAX_UINT256.toString(16),
    );
    // Permit2.approve(token, router, MAX_UINT160, MAX_UINT48) — amount encoded
    expect(approveCall(sendTransaction, 1).data).toContain(
      MAX_UINT160.toString(16),
    );
  });

  it("skips both approval legs entirely once max allowances are already granted", async () => {
    const { wallet, sendTransaction } = makeWallet({
      erc20Allowance: MAX_UINT256,
      permit2Allowance: {
        amount: MAX_UINT160,
        expiration: Number(MAX_UINT48),
        nonce: 0,
      },
    });
    const steps = await ensureSwapApprovals(wallet, TOKEN_IN, 1_000n, false);

    expect(steps).toEqual([]);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("does not re-approve Permit2 while comfortably before its expiry", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { wallet, sendTransaction } = makeWallet({
      erc20Allowance: MAX_UINT256,
      permit2Allowance: {
        amount: MAX_UINT160,
        expiration: nowSeconds + 2 * 60 * 60, // 2 hours out
        nonce: 0,
      },
    });
    const steps = await ensureSwapApprovals(wallet, TOKEN_IN, 1_000n, false);

    expect(steps).toEqual([]);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("resets a legacy smaller nonzero allowance to zero before granting the new maximum", async () => {
    const { wallet, sendTransaction } = makeWallet({
      erc20Allowance: 500n, // insufficient AND nonzero: the exact-approval-era leftover case
    });
    const steps = await ensureSwapApprovals(wallet, TOKEN_IN, 1_000n, false);

    expect(steps.map((s) => s.step)).toEqual([
      "erc20-permit2-reset",
      "erc20-permit2",
      "permit2-router",
    ]);
    // approve(permit2, 0): the trailing amount word is all zeros
    expect(approveCall(sendTransaction, 0).data.slice(-64)).toBe(
      "0".repeat(64),
    );
    expect(approveCall(sendTransaction, 1).data).toContain(
      MAX_UINT256.toString(16),
    );
  });

  it("returns no steps for native ETH input", async () => {
    const { wallet, sendTransaction } = makeWallet();
    const steps = await ensureSwapApprovals(wallet, TOKEN_IN, 1_000n, true);
    expect(steps).toEqual([]);
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});

describe("ensureErc20Allowance", () => {
  it("grants a reusable maximum allowance on first encounter with a spender", async () => {
    const { wallet, sendTransaction } = makeWallet();
    const steps = await ensureErc20Allowance(wallet, TOKEN_IN, SPENDER, 1_000n);

    expect(steps.map((s) => s.step)).toEqual(["erc20-spender"]);
    expect(approveCall(sendTransaction, 0).data).toContain(
      MAX_UINT256.toString(16),
    );
  });

  it("skips approval entirely once a max allowance is already granted, regardless of the requested amount", async () => {
    const { wallet, sendTransaction } = makeWallet({
      spenderAllowance: MAX_UINT256,
    });
    const steps = await ensureErc20Allowance(
      wallet,
      TOKEN_IN,
      SPENDER,
      10_000_000n,
    );
    expect(steps).toEqual([]);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("resets a legacy smaller nonzero allowance to zero before granting the new maximum", async () => {
    const { wallet, sendTransaction } = makeWallet({ spenderAllowance: 500n });
    const steps = await ensureErc20Allowance(wallet, TOKEN_IN, SPENDER, 1_000n);

    expect(steps.map((s) => s.step)).toEqual([
      "erc20-spender-reset",
      "erc20-spender",
    ]);
    expect(approveCall(sendTransaction, 1).data).toContain(
      MAX_UINT256.toString(16),
    );
  });
});
