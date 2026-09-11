import {
  RECENT_SWAPS_QUERY,
  VENDOR_ACTIVITY_QUERY,
  normalizeSwaps,
  normalizeVendorActivity,
  readSubgraphMeta,
  type SubgraphSwap,
  type VendorAccountTotals,
  type VendorEvent,
} from "@/lib/graph/queries";
import type { RunnerConfig } from "./config";
import type { AgentWallet } from "./wallet";
import { paidFetch } from "./paid-fetch";

export interface AgentHistory {
  swaps: SubgraphSwap[];
  vendorEvents: VendorEvent[];
  vendorTotals: VendorAccountTotals[];
  sources: {
    uniswap: HistorySourceState;
    vendor: HistorySourceState;
  };
}

export interface HistorySourceState {
  available: boolean;
  blockNumber: string | null;
  lagBlocks: number | null;
  hasIndexingErrors: boolean;
}

const HISTORY_LIMIT = 10;

/**
 * What this agent has already done on-chain, from The Graph over x402 —
 * pay-per-query in USDC on Base, no API key anywhere in the runner.
 *
 * This is the agent's memory, not a trading signal. Daily-quest tasks are a
 * reward requirement and are performed regardless of market conditions, so
 * nothing here decides whether to act; it gives the narration something true to
 * say about how this run compares to the last few.
 */
export async function fetchAgentHistory(
  wallet: AgentWallet,
  config: RunnerConfig,
  /** Same tally the gateway calls use: a Graph query is billed like any other. */
  track?: (result: { paid: boolean; discounted: boolean }) => void,
): Promise<AgentHistory> {
  const address = wallet.address.toLowerCase();
  const [swaps, vendor, currentBlock] = await Promise.all([
    querySubgraph(
      wallet,
      config,
      config.graphUniswapSubgraphId,
      RECENT_SWAPS_QUERY,
      { origins: [address], first: HISTORY_LIMIT },
      track,
    ),
    querySubgraph(
      wallet,
      config,
      config.graphVendorSubgraphId,
      VENDOR_ACTIVITY_QUERY,
      { accounts: [address], first: HISTORY_LIMIT },
      track,
    ),
    wallet.publicClient.getBlockNumber(),
  ]);

  const activity = normalizeVendorActivity(vendor);
  const sourceState = (data: unknown): HistorySourceState => {
    const meta = readSubgraphMeta(data);
    const indexedBlock = meta?.blockNumber ? BigInt(meta.blockNumber) : null;
    return {
      available: data !== null && data !== undefined && Boolean(meta),
      blockNumber: meta?.blockNumber ?? null,
      lagBlocks:
        indexedBlock === null
          ? null
          : Number(
              currentBlock > indexedBlock ? currentBlock - indexedBlock : 0n,
            ),
      hasIndexingErrors: meta?.hasIndexingErrors ?? false,
    };
  };
  return {
    swaps: normalizeSwaps(swaps),
    vendorEvents: activity.events,
    vendorTotals: activity.totals,
    sources: {
      uniswap: sourceState(swaps),
      vendor: sourceState(vendor),
    },
  };
}

async function querySubgraph(
  wallet: AgentWallet,
  config: RunnerConfig,
  subgraphId: string | undefined,
  query: string,
  variables: Record<string, unknown>,
  track?: (result: { paid: boolean; discounted: boolean }) => void,
): Promise<unknown> {
  if (!subgraphId) return null;

  const url = `${config.graphGatewayUrl}/api/x402/subgraphs/id/${subgraphId}`;
  try {
    const result = await paidFetch<Record<string, unknown>>(wallet, url, {
      method: "POST",
      body: { query, variables },
    });
    track?.(result);
    return result.data ?? null;
  } catch {
    // History is context, never a precondition: losing it must not stop a run.
    return null;
  }
}

/** One line the narration can use without restating the whole history. */
export function summarizeHistory(history: AgentHistory): string | null {
  const parts: string[] = [];
  if (history.swaps.length) {
    parts.push(`${history.swaps.length} recent swap(s) on record`);
  }
  if (history.vendorTotals.length) {
    const stage = Math.max(...history.vendorTotals.map((t) => t.stage));
    parts.push(`vendor stage ${stage}`);
  }
  if (history.vendorEvents.length) {
    parts.push(`${history.vendorEvents.length} recent vendor action(s)`);
  }
  const stale = Object.entries(history.sources ?? {})
    .filter(
      ([, state]) => state.hasIndexingErrors || (state.lagBlocks ?? 0) > 600,
    )
    .map(([name]) => name);
  if (stale.length) parts.push(`${stale.join(" and ")} history may be stale`);
  return parts.length ? parts.join("; ") : null;
}
