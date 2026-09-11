import { UNISWAP_ADDRESSES } from "@/lib/uniswap/constants";
import { ERC20_ABI } from "@/lib/blockchain/shared/abi-definitions";
import { DG_TOKEN_VENDOR_ABI } from "@/lib/blockchain/shared/vendor-abi";
import type { ReadOnlyAgentWallet } from "./actions/types";

export interface WalletBalances {
  /** Raw smallest-unit amounts, keyed by the symbol the task configs use. */
  ETH: bigint;
  USDC: bigint;
  UP: bigint;
  DG: bigint;
}

/** Held back from every ETH-spending decision so the next tx can still be sent. */
export const GAS_RESERVE_WEI = 5_000_000_000_000n;

export function spendableEth(
  balance: bigint,
  minimumReserveRaw: bigint = GAS_RESERVE_WEI,
): {
  balance: bigint;
  reserved: bigint;
  spendable: bigint;
} {
  const reserved = balance < minimumReserveRaw ? balance : minimumReserveRaw;
  return { balance, reserved, spendable: balance - reserved };
}

/**
 * What the agent can actually spend right now.
 *
 * This is the fact the sequencing turns on: a run can ask for a UP trade the
 * wallet has no UP for, and the only way through is to acquire it first.
 */
export async function readBalances(
  wallet: ReadOnlyAgentWallet,
): Promise<WalletBalances> {
  const erc20 = async (token: `0x${string}`): Promise<bigint> => {
    return (await wallet.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [wallet.address],
    })) as bigint;
  };

  const dgToken = await vendorSwapToken(wallet);

  const [eth, usdc, up, dg] = await Promise.all([
    wallet.publicClient.getBalance({ address: wallet.address }),
    erc20(UNISWAP_ADDRESSES.usdc),
    erc20(UNISWAP_ADDRESSES.up),
    dgToken ? erc20(dgToken) : Promise.resolve(0n),
  ]);

  return { ETH: eth, USDC: usdc, UP: up, DG: dg };
}

async function vendorSwapToken(
  wallet: ReadOnlyAgentWallet,
): Promise<`0x${string}` | null> {
  const vendor = process.env.NEXT_PUBLIC_DG_VENDOR_ADDRESS;
  if (!vendor || !/^0x[a-fA-F0-9]{40}$/.test(vendor)) return null;
  try {
    const config = (await wallet.publicClient.readContract({
      address: vendor as `0x${string}`,
      abi: DG_TOKEN_VENDOR_ABI,
      functionName: "getTokenConfig",
    })) as { swapToken: `0x${string}` };
    return config.swapToken;
  } catch {
    return null;
  }
}

/** Readable for the model, which reasons about magnitudes rather than wei. */
export function describeBalances(balances: WalletBalances): string {
  return (Object.keys(balances) as Array<keyof WalletBalances>)
    .map((symbol) => `${symbol}=${balances[symbol].toString()}`)
    .join(" ");
}
