import { formatUnits, parseUnits } from "viem";

export function parseAmount(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return parseUnits(trimmed, decimals);
  } catch {
    return null;
  }
}

export function formatAmount(
  value: bigint,
  decimals: number,
  maxDecimals = 4,
): string {
  const full = formatUnits(value, decimals);
  const [intPart, fracPart] = full.split(".");
  if (!fracPart) return intPart || "0";

  const trimmedFrac = fracPart.slice(0, maxDecimals).replace(/0+$/, "");
  return trimmedFrac ? `${intPart || "0"}.${trimmedFrac}` : intPart || "0";
}

export function formatAmountForInput(value: bigint, decimals: number): string {
  const full = formatUnits(value, decimals);
  if (!full.includes(".")) return full;
  return full.replace(/\.?0+$/, "");
}

export function calculateFee(
  amount: bigint,
  feeBps: bigint,
): {
  fee: bigint;
  net: bigint;
} {
  const fee = (amount * feeBps) / 10_000n;
  return { fee, net: amount - fee };
}

export function estimateBuy(
  amount: bigint,
  buyFeeBps: bigint,
  exchangeRate: bigint,
): { fee: bigint; netBase: bigint; outSwap: bigint } {
  const { fee, net } = calculateFee(amount, buyFeeBps);
  const outSwap = net * exchangeRate;
  return { fee, netBase: net, outSwap };
}

/**
 * Inverse of `estimateBuy`: the base-token input that yields at least `outSwap`.
 *
 * Both divisions round up, so the result never under-buys — a shortfall here
 * would be spent as a second transaction to cover the remainder.
 */
export function estimateBuyInput(
  outSwap: bigint,
  buyFeeBps: bigint,
  exchangeRate: bigint,
): bigint | null {
  if (outSwap <= 0n || exchangeRate <= 0n || buyFeeBps >= 10_000n) return null;
  const netBase = (outSwap + exchangeRate - 1n) / exchangeRate;
  const afterFee = 10_000n - buyFeeBps;
  return (netBase * 10_000n + afterFee - 1n) / afterFee;
}

export function estimateSell(
  amount: bigint,
  sellFeeBps: bigint,
  exchangeRate: bigint,
): { fee: bigint; netSwap: bigint; outBase: bigint } {
  const { fee, net } = calculateFee(amount, sellFeeBps);
  const outBase = exchangeRate > 0n ? net / exchangeRate : 0n;
  return { fee, netSwap: net, outBase };
}
