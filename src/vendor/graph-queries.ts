/**
 * Subgraph documents and response shapes, with no transport of their own.
 *
 * Two callers read the same data over different rails: the agent runner pays
 * per query in USDC over x402, and the web server queries with a Subgraph
 * Studio key. Keeping the documents here is what stops those two growing
 * separate copies of the same query and drifting apart.
 */

import { z } from "zod";

/** One Uniswap fill, as the V3 subgraph records it. */
export interface SubgraphSwap {
  id: string;
  timestamp: string;
  timestampIso: string;
  // The V3 subgraph returns decimal-adjusted token units rather than wei.
  amount0: string;
  amount1: string;
  amountUSD: string;
  origin: string;
  transactionHash: string;
  token0Symbol: string;
  token1Symbol: string;
  tokenIn: { symbol: string; amount: string };
  tokenOut: { symbol: string; amount: string };
}

export interface VendorEvent {
  id: string;
  account: string;
  kind: "purchase" | "sale" | "light_up" | "stage_upgrade";
  timestamp: string;
  timestampIso: string;
  txHash: string;
  /** Base-token side of the trade, or the burn for a light-up. */
  baseTokenAmount: string | null;
  /** DG side of the trade. */
  swapTokenAmount: string | null;
  /** Stage reached, for an upgrade. */
  newStage: number | null;
}

export interface VendorAccountTotals {
  account: string;
  stage: number;
  totalBought: string;
  totalSold: string;
  lightUpCount: number;
}

export interface SubgraphMeta {
  blockNumber: string | null;
  hasIndexingErrors: boolean;
}

/**
 * `origin` is the EOA that sent the transaction, so a Universal Router swap
 * still attributes to the wallet that initiated it rather than the router.
 */
export const RECENT_SWAPS_QUERY = `
  query RecentSwaps($origins: [String!]!, $first: Int!) {
    _meta { block { number } hasIndexingErrors }
    swaps(
      where: { origin_in: $origins }
      orderBy: timestamp
      orderDirection: desc
      first: $first
    ) {
      id
      timestamp
      amount0
      amount1
      amountUSD
      origin
      transaction { id }
      token0 { symbol }
      token1 { symbol }
    }
  }
`;

export const VENDOR_ACTIVITY_QUERY = `
  query VendorActivity($accounts: [String!]!, $first: Int!) {
    _meta { block { number } hasIndexingErrors }
    vendorAccounts(where: { id_in: $accounts }) {
      id
      stage
      totalBought
      totalSold
      lightUpCount
    }
    purchases(
      where: { account_in: $accounts }
      orderBy: timestamp
      orderDirection: desc
      first: $first
    ) {
      id
      account { id }
      timestamp
      txHash
      baseTokenAmount
      swapTokenAmount
    }
    sales(
      where: { account_in: $accounts }
      orderBy: timestamp
      orderDirection: desc
      first: $first
    ) {
      id
      account { id }
      timestamp
      txHash
      baseTokenAmount
      swapTokenAmount
    }
    lightUps(
      where: { account_in: $accounts }
      orderBy: timestamp
      orderDirection: desc
      first: $first
    ) {
      id
      account { id }
      timestamp
      txHash
      burnAmount
    }
    stageUpgrades(
      where: { account_in: $accounts }
      orderBy: timestamp
      orderDirection: desc
      first: $first
    ) {
      id
      account { id }
      timestamp
      txHash
      newStage
    }
  }
`;

const metaSchema = z
  .object({
    block: z.object({ number: z.number().int().nonnegative() }).strict(),
    hasIndexingErrors: z.boolean(),
  })
  .strict();

const rawSwapSchema = z
  .object({
    id: z.string(),
    timestamp: z.string(),
    amount0: z.string(),
    amount1: z.string(),
    amountUSD: z.string(),
    origin: z.string(),
    transaction: z.object({ id: z.string() }).strict(),
    token0: z.object({ symbol: z.string() }).strict(),
    token1: z.object({ symbol: z.string() }).strict(),
  })
  .strict();

const swapsResponseSchema = z
  .object({
    _meta: metaSchema.optional(),
    swaps: z.array(rawSwapSchema).default([]),
  })
  .strict();

function magnitude(amount: string): string {
  return amount.startsWith("-") ? amount.slice(1) : amount;
}

function toTimestampIso(timestamp: string): string {
  const milliseconds = Number(timestamp) * 1000;
  if (!Number.isFinite(milliseconds)) throw new Error("Invalid timestamp");
  return new Date(milliseconds).toISOString();
}

export function normalizeSwaps(data: unknown): SubgraphSwap[] {
  if (data === null || data === undefined) return [];
  const raw = swapsResponseSchema.parse(data).swaps;
  return raw.map((swap) => {
    const token0Symbol = String(swap.token0?.symbol ?? "?");
    const token1Symbol = String(swap.token1?.symbol ?? "?");
    const amount0 = String(swap.amount0);
    const amount1 = String(swap.amount1);
    const zeroLeftPool = amount0.startsWith("-");
    return {
      id: swap.id,
      timestamp: String(swap.timestamp),
      timestampIso: toTimestampIso(String(swap.timestamp)),
      amount0,
      amount1,
      amountUSD: String(swap.amountUSD),
      origin: String(swap.origin).toLowerCase(),
      transactionHash: String(swap.transaction?.id ?? ""),
      token0Symbol,
      token1Symbol,
      tokenIn: zeroLeftPool
        ? { symbol: token1Symbol, amount: magnitude(amount1) }
        : { symbol: token0Symbol, amount: magnitude(amount0) },
      tokenOut: zeroLeftPool
        ? { symbol: token0Symbol, amount: magnitude(amount0) }
        : { symbol: token1Symbol, amount: magnitude(amount1) },
    };
  });
}

const rawVendorEventSchema = z
  .object({
    id: z.string(),
    account: z.object({ id: z.string() }).strict(),
    timestamp: z.string(),
    txHash: z.string(),
    baseTokenAmount: z.string().optional(),
    swapTokenAmount: z.string().optional(),
    burnAmount: z.string().optional(),
    newStage: z.union([z.number(), z.string()]).optional(),
  })
  .strict();

type RawVendorEvent = z.infer<typeof rawVendorEventSchema>;

const vendorResponseSchema = z
  .object({
    _meta: metaSchema.optional(),
    vendorAccounts: z
      .array(
        z
          .object({
            id: z.string(),
            stage: z.union([z.number(), z.string()]),
            totalBought: z.string(),
            totalSold: z.string(),
            lightUpCount: z.union([z.number(), z.string()]),
          })
          .strict(),
      )
      .default([]),
    purchases: z.array(rawVendorEventSchema).default([]),
    sales: z.array(rawVendorEventSchema).default([]),
    lightUps: z.array(rawVendorEventSchema).default([]),
    stageUpgrades: z.array(rawVendorEventSchema).default([]),
  })
  .strict();

export function normalizeVendorActivity(
  data: unknown,
  limit = 10,
): {
  totals: VendorAccountTotals[];
  events: VendorEvent[];
} {
  if (data === null || data === undefined) return { totals: [], events: [] };
  const source = vendorResponseSchema.parse(data);

  const totals: VendorAccountTotals[] = (source.vendorAccounts ?? []).map(
    (account) => ({
      account: String(account.id).toLowerCase(),
      stage: Number(account.stage ?? 0),
      totalBought: String(account.totalBought ?? "0"),
      totalSold: String(account.totalSold ?? "0"),
      lightUpCount: Number(account.lightUpCount ?? 0),
    }),
  );

  const collect = (
    rows: RawVendorEvent[] | undefined,
    kind: VendorEvent["kind"],
  ): VendorEvent[] =>
    (rows ?? []).map((row) => ({
      id: row.id,
      account: row.account.id.toLowerCase(),
      kind,
      timestamp: String(row.timestamp),
      timestampIso: toTimestampIso(String(row.timestamp)),
      txHash: String(row.txHash),
      baseTokenAmount: row.baseTokenAmount ?? row.burnAmount ?? null,
      swapTokenAmount: row.swapTokenAmount ?? null,
      newStage: row.newStage === undefined ? null : Number(row.newStage),
    }));

  const events = [
    ...collect(source.purchases, "purchase"),
    ...collect(source.sales, "sale"),
    ...collect(source.lightUps, "light_up"),
    ...collect(source.stageUpgrades, "stage_upgrade"),
  ]
    .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
    .slice(0, limit);

  return { totals, events };
}

export function readSubgraphMeta(data: unknown): SubgraphMeta | null {
  if (!data || typeof data !== "object") return null;
  const parsed = metaSchema.safeParse((data as Record<string, unknown>)._meta);
  return parsed.success
    ? {
        blockNumber: String(parsed.data.block.number),
        hasIndexingErrors: parsed.data.hasIndexingErrors,
      }
    : null;
}
