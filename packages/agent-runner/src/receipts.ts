import { decodeEventLog, isAddressEqual, type Hex } from "viem";
import { ERC20_TRANSFER_EVENT } from "@/lib/blockchain/shared/abi-definitions";
import { assetAmount, type Asset, type AssetAmount } from "./actions/types";

export interface ReceiptLog {
  address: string;
  topics: readonly Hex[];
  data: Hex;
}

export interface KnownToken {
  asset: Asset;
  tokenAddress: `0x${string}`;
  decimals: number;
}

function inboundTransfer(
  log: ReceiptLog,
  wallet: `0x${string}`,
): bigint | null {
  // ERC-721 Transfer shares the signature but indexes a fourth topic.
  if (log.topics.length !== 3) return null;
  try {
    const decoded = decodeEventLog({
      abi: ERC20_TRANSFER_EVENT,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });
    return isAddressEqual(decoded.args.to, wallet) ? decoded.args.value : null;
  } catch {
    return null;
  }
}

// Native ETH leaves no Transfer log, so an action paying out ETH reports null.
export function receivedFromLogs(
  logs: readonly ReceiptLog[],
  wallet: `0x${string}`,
  tokens: readonly KnownToken[],
  spentAsset?: Asset,
): AssetAmount | null {
  const totals = new Map<Asset, bigint>();

  for (const log of logs) {
    const token = tokens.find((known) =>
      isAddressEqual(known.tokenAddress, log.address as `0x${string}`),
    );
    if (!token || token.asset === spentAsset) continue;
    const value = inboundTransfer(log, wallet);
    if (value) totals.set(token.asset, (totals.get(token.asset) ?? 0n) + value);
  }

  for (const token of tokens) {
    const raw = totals.get(token.asset);
    if (raw && raw > 0n) {
      return assetAmount(token.asset, raw, token.decimals, token.tokenAddress);
    }
  }
  return null;
}
