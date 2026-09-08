import { createHash } from "crypto";
import { formatUnits } from "viem";
import {
  DEFAULT_SLIPPAGE_BPS,
  FEE_CONFIG,
  UNISWAP_ADDRESSES,
} from "@/lib/uniswap/constants";
import { quoteSwapRoute, resolveSwapRoute } from "@/lib/uniswap/route";
import { actionByName, actionForTaskType } from "./actions/registry";
import { qualifyingBuyForPoints, upRequiredForDg } from "./actions/vendor";
import {
  actionCandidateSchema,
  actionResultSchema,
  assetAmount,
  type ActionAnalysis,
  type ActionCandidate,
  type ActionContext,
  type ActionPurpose,
  type Asset,
  type RequirementReference,
} from "./actions/types";
import { readBalances, spendableEth, type WalletBalances } from "./balances";
import type { RunnerConfig } from "./config";
import type { AgentWallet } from "./wallet";

export interface CandidateTask {
  id: string;
  title: string;
  taskType: string;
  taskConfig: Record<string, unknown>;
}

export interface CandidateObservation {
  stateVersion: string;
  blockNumber: string;
  balances: ReturnType<typeof assetAmount>[];
  candidates: ActionCandidate[];
  ownerBlockers: Array<{ taskId: string; code: string; message: string }>;
  fatalBlockers: Array<{ taskId: string; code: string; message: string }>;
}

const assetDecimals: Record<Asset, number> = {
  ETH: 18,
  USDC: 6,
  UP: 18,
  DG: 18,
};

function tokenFor(asset: Asset): `0x${string}` | null {
  if (asset === "USDC") return UNISWAP_ADDRESSES.usdc;
  if (asset === "UP") return UNISWAP_ADDRESSES.up;
  return null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function candidateId(value: unknown): `cand_${string}` {
  const digest = createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex")
    .slice(0, 32);
  return `cand_${digest}`;
}

function analysisState(analysis: ActionAnalysis): string {
  return JSON.stringify(
    stableValue({
      executableNow: analysis.executableNow,
      requirements: analysis.requirements,
      effects: analysis.effects,
      blockers: analysis.blockers,
    }),
  );
}

/**
 * Deliberately not derived from the block number.
 *
 * Base produces a block every couple of seconds, so hashing it would make every
 * candidate stale before the planner could answer, and the staleness guard
 * would have to be disabled to get anything done. Hashing what a candidate
 * actually depends on is what lets that guard stay enforced.
 */
function stateVersion(balances: Record<Asset, bigint>) {
  return createHash("sha256")
    .update(
      Object.entries(balances)
        .map(([asset, value]) => `${asset}:${value}`)
        .join("|"),
    )
    .digest("hex");
}

/**
 * Gross a target output up past the costs taken after the quote.
 *
 * The router pays `FEE_CONFIG.feeBips` of the output to the fee recipient and
 * settles against a slippage-discounted minimum, so an input sized to the bare
 * quote lands short — and that shortfall becomes another swap, and another.
 */
function grossUpForOutputCosts(amount: bigint, slippageBps: number): bigint {
  const afterFee = 10_000n - BigInt(FEE_CONFIG.feeBips);
  const afterSlippage = 10_000n - BigInt(slippageBps);
  if (afterFee <= 0n || afterSlippage <= 0n) return amount;
  const withFee = (amount * 10_000n + afterFee - 1n) / afterFee;
  return (withFee * 10_000n + afterSlippage - 1n) / afterSlippage;
}

async function amountInForOutput(args: {
  wallet: AgentWallet;
  pair: "ETH_UP" | "UP_USDC";
  direction: "A_TO_B" | "B_TO_A";
  maximum: bigint;
  requiredOutput: bigint;
  slippageBps: number;
}): Promise<{ amountIn: bigint; amountOut: bigint } | null> {
  if (args.maximum <= 0n || args.requiredOutput <= 0n) return null;
  const target = grossUpForOutputCosts(args.requiredOutput, args.slippageBps);
  const route = resolveSwapRoute(args.pair, args.direction);
  const maxOut = await quoteSwapRoute(
    args.wallet.publicClient,
    route,
    args.maximum,
  );
  if (maxOut < target) return null;

  // Enough halvings to actually converge: a fixed low count leaves `high` far
  // above the true input, and the agent then swaps more than the task needs.
  const iterations = Math.min(args.maximum.toString(2).length + 1, 128);
  let low = 1n;
  let high = args.maximum;
  for (let attempt = 0; attempt < iterations && low < high; attempt += 1) {
    const midpoint = (low + high) / 2n;
    const output = await quoteSwapRoute(
      args.wallet.publicClient,
      route,
      midpoint,
    );
    if (output >= target) high = midpoint;
    else low = midpoint + 1n;
  }
  const amountOut = await quoteSwapRoute(args.wallet.publicClient, route, high);
  return { amountIn: high, amountOut };
}

function rankCandidates(candidates: ActionCandidate[]): ActionCandidate[] {
  return candidates
    .sort((a, b) => {
      if (a.purpose.kind !== b.purpose.kind) {
        return a.purpose.kind === "quest_task" ? -1 : 1;
      }
      if (a.usefulEffects !== b.usefulEffects)
        return b.usefulEffects - a.usefulEffects;
      if (a.estimatedCostUsd !== null && b.estimatedCostUsd !== null) {
        return Number(a.estimatedCostUsd) - Number(b.estimatedCostUsd);
      }
      if (a.estimatedCostUsd !== null) return -1;
      if (b.estimatedCostUsd !== null) return 1;
      return a.candidateId.localeCompare(b.candidateId);
    })
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

/**
 * Analyse one prospective action.
 *
 * Returns the analysis even when no candidate comes of it, because a
 * prerequisite that is itself blocked is exactly the thing whose own shortfall
 * has to be resolved next.
 */
async function analyzeCandidate(args: {
  actionName: string;
  input: Record<string, unknown>;
  purpose: ActionPurpose;
  wallet: AgentWallet;
  config: RunnerConfig;
  stateVersion: string;
  explanation: string;
  estimatedCostUsd?: string | null;
  usefulEffects?: number;
}): Promise<{
  candidate: ActionCandidate | null;
  analysis: ActionAnalysis;
} | null> {
  const action = actionByName(args.actionName);
  if (!action?.analyze || !action.inputSchema) return null;
  if (!action.supportsNetwork(args.config.chainId)) return null;
  const input = action.inputSchema.parse(args.input) as Record<string, unknown>;
  const analysis = await action.analyze(
    {
      wallet: args.wallet,
      config: args.config,
      purpose: args.purpose,
      stateVersion: args.stateVersion,
    },
    input,
  );
  if (!analysis.executableNow) return { candidate: null, analysis };
  const expiresAt = analysis.quote.expiresAt;
  const idInput = {
    actionName: action.name,
    version: action.version,
    purpose: args.purpose,
    input,
    stateVersion: args.stateVersion,
  };
  return {
    analysis,
    candidate: actionCandidateSchema.parse({
      candidateId: candidateId(idInput),
      actionName: action.name,
      actionVersion: action.version,
      purpose: args.purpose,
      input,
      analysis,
      stateVersion: args.stateVersion,
      estimatedCostUsd: args.estimatedCostUsd ?? null,
      usefulEffects: args.usefulEffects ?? 1,
      rank: 1,
      explanation: args.explanation,
      expiresAt,
    }),
  };
}

interface PrerequisiteArgs {
  wallet: AgentWallet;
  config: RunnerConfig;
  balances: WalletBalances;
  stateVersion: string;
  taskId: string;
  requirement: RequirementReference;
  depth: number;
}

/**
 * One shortfall in, the actions that would close it out.
 *
 * A step below the top is capped because each one spends real gas, and because
 * a protocol whose funding path loops would otherwise be free to do so.
 */
const MAX_PREREQUISITE_DEPTH = 2;

export async function prerequisiteCandidates(
  args: PrerequisiteArgs,
): Promise<ActionCandidate[]> {
  const deficit = BigInt(args.requirement.deficitRaw);
  if (deficit <= 0n || args.depth >= MAX_PREREQUISITE_DEPTH) return [];

  // The task being unblocked stays the attribution, however deep the chain
  // goes: a swap that funds a buy that fills a sell still serves the sell.
  const purpose: ActionPurpose = {
    kind: "prerequisite",
    forTaskId: args.taskId,
    resolves: [args.requirement],
  };

  if (args.requirement.kind === "asset" && args.requirement.asset === "UP") {
    return swapFundingCandidates(args, purpose, deficit);
  }

  if (args.requirement.kind === "asset" && args.requirement.asset === "DG") {
    const upNeeded = await upRequiredForDg(
      {
        wallet: args.wallet,
        config: args.config,
        purpose,
        stateVersion: args.stateVersion,
      },
      deficit,
    ).catch(() => null);
    if (!upNeeded) return [];
    return chainedCandidates(args, purpose, {
      actionName: "p2e_vendor_buy",
      input: { amountRaw: upNeeded.toString() },
      explanation: `Buy the ${deficit} raw DG this task is short of.`,
    });
  }

  if (args.requirement.kind === "fuel") {
    return chainedCandidates(args, purpose, {
      actionName: "p2e_vendor_light_up",
      input: { targetStage: null },
      explanation: `Light up to earn the ${deficit} raw fuel this task is short of.`,
    });
  }

  if (args.requirement.kind === "points") {
    const qualifyingBuy = await qualifyingBuyForPoints({
      wallet: args.wallet,
      config: args.config,
      purpose,
      stateVersion: args.stateVersion,
    }).catch(() => null);
    if (!qualifyingBuy) return [];
    return chainedCandidates(args, purpose, {
      actionName: "p2e_vendor_buy",
      input: { amountRaw: qualifyingBuy.toString() },
      explanation: `Make a qualifying vendor buy to earn points toward this task's ${deficit} raw-point deficit.`,
    });
  }

  return [];
}

/** The prerequisite itself, or — when it is also short — what would unblock it. */
async function chainedCandidates(
  args: PrerequisiteArgs,
  purpose: ActionPurpose,
  step: {
    actionName: string;
    input: Record<string, unknown>;
    explanation: string;
  },
): Promise<ActionCandidate[]> {
  const outcome = await analyzeCandidate({
    actionName: step.actionName,
    input: step.input,
    purpose,
    wallet: args.wallet,
    config: args.config,
    stateVersion: args.stateVersion,
    explanation: step.explanation,
  }).catch(() => null);
  if (!outcome) return [];
  if (outcome.candidate) return [outcome.candidate];

  const nested: ActionCandidate[] = [];
  for (const requirement of outcome.analysis.requirements) {
    nested.push(
      ...(await prerequisiteCandidates({
        ...args,
        requirement: requirement.reference,
        depth: args.depth + 1,
      })),
    );
  }
  return nested;
}

async function swapFundingCandidates(
  args: PrerequisiteArgs,
  purpose: ActionPurpose,
  deficit: bigint,
): Promise<ActionCandidate[]> {
  const slippageBps = args.config.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const ethAvailable = spendableEth(args.balances.ETH);
  const sources = [
    {
      pair: "ETH_UP" as const,
      direction: "A_TO_B" as const,
      maximum: ethAvailable,
      asset: "ETH" as const,
    },
    {
      pair: "UP_USDC" as const,
      direction: "B_TO_A" as const,
      maximum: args.balances.USDC,
      asset: "USDC" as const,
    },
  ];
  const candidates: ActionCandidate[] = [];
  for (const source of sources) {
    try {
      const quote = await amountInForOutput({
        wallet: args.wallet,
        pair: source.pair,
        direction: source.direction,
        maximum: source.maximum,
        requiredOutput: deficit,
        slippageBps,
      });
      if (!quote) continue;
      let costUsd: string | null = null;
      if (source.asset === "USDC") costUsd = formatUnits(quote.amountIn, 6);
      else {
        try {
          const usd = await quoteSwapRoute(
            args.wallet.publicClient,
            resolveSwapRoute("ETH_USDC", "A_TO_B"),
            quote.amountIn,
          );
          costUsd = formatUnits(usd, 6);
        } catch {
          costUsd = null;
        }
      }
      const outcome = await analyzeCandidate({
        actionName: "p2e_uniswap_swap",
        input: {
          pair: source.pair,
          direction: source.direction,
          amountInRaw: quote.amountIn.toString(),
        },
        purpose,
        wallet: args.wallet,
        config: args.config,
        stateVersion: args.stateVersion,
        explanation: `Acquire the ${deficit} raw UP deficit using ${source.asset}.`,
        estimatedCostUsd: costUsd,
      });
      if (outcome?.candidate) candidates.push(outcome.candidate);
    } catch {
      continue;
    }
  }
  return candidates;
}

export async function observeCandidates(args: {
  wallet: AgentWallet;
  config: RunnerConfig;
  tasks: CandidateTask[];
  settledTaskIds?: ReadonlySet<string>;
  rejectedCandidateIds?: ReadonlySet<string>;
}): Promise<CandidateObservation> {
  const [balances, blockNumber] = await Promise.all([
    readBalances(args.wallet),
    args.wallet.publicClient.getBlockNumber(),
  ]);
  const version = stateVersion(balances);
  const candidates: ActionCandidate[] = [];
  const ownerBlockers: CandidateObservation["ownerBlockers"] = [];
  const fatalBlockers: CandidateObservation["fatalBlockers"] = [];

  for (const task of args.tasks) {
    if (args.settledTaskIds?.has(task.id)) continue;
    const action = actionForTaskType(task.taskType);
    if (!action || !action.analyze || !action.inputSchema) {
      ownerBlockers.push({
        taskId: task.id,
        code: "OWNER_ACTION_REQUIRED",
        message: `Task type ${task.taskType} must be completed in the app.`,
      });
      continue;
    }
    if (!action.supportsNetwork(args.config.chainId)) {
      fatalBlockers.push({
        taskId: task.id,
        code: "UNSUPPORTED_CHAIN",
        message: `${task.taskType} is not supported on this chain.`,
      });
      continue;
    }

    let input: unknown;
    try {
      input = action.parseTaskConfig(task.taskConfig);
    } catch (error) {
      fatalBlockers.push({
        taskId: task.id,
        code: "INVALID_TASK_CONFIG",
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const purpose: ActionPurpose = { kind: "quest_task", taskId: task.id };
    const analysis = await action.analyze(
      {
        wallet: args.wallet,
        config: args.config,
        purpose,
        stateVersion: version,
      },
      input,
    );
    if (analysis.executableNow) {
      const inputRecord = input as Record<string, unknown>;
      const candidate = actionCandidateSchema.parse({
        candidateId: candidateId({
          actionName: action.name,
          version: action.version,
          purpose,
          input: inputRecord,
          stateVersion: version,
        }),
        actionName: action.name,
        actionVersion: action.version,
        purpose,
        input: inputRecord,
        analysis,
        stateVersion: version,
        estimatedCostUsd: null,
        usefulEffects: 1,
        rank: 1,
        explanation: `Complete quest task “${task.title}”.`,
        expiresAt: analysis.quote.expiresAt,
      });
      candidates.push(candidate);
    }

    for (const blocker of analysis.blockers) {
      if (blocker.resolution === "owner")
        ownerBlockers.push({
          taskId: task.id,
          code: blocker.code,
          message: blocker.message,
        });
      if (blocker.resolution === "fatal")
        fatalBlockers.push({
          taskId: task.id,
          code: blocker.code,
          message: blocker.message,
        });
    }
    let prerequisitesFound = 0;
    for (const requirement of analysis.requirements) {
      const prerequisites = await prerequisiteCandidates({
        wallet: args.wallet,
        config: args.config,
        balances,
        stateVersion: version,
        taskId: task.id,
        requirement: requirement.reference,
        depth: 0,
      });
      prerequisitesFound += prerequisites.length;
      candidates.push(...prerequisites);
    }
    if (
      prerequisitesFound === 0 &&
      analysis.blockers.some((blocker) => blocker.resolution === "agent")
    ) {
      const blocker = analysis.blockers.find(
        (item) => item.resolution === "agent",
      )!;
      ownerBlockers.push({
        taskId: task.id,
        code: "OWNER_PREREQUISITE_UNAVAILABLE",
        message: `The agent could not build a safe prerequisite for ${blocker.code}.`,
      });
    }
  }

  const unique = new Map(
    candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const filtered = [...unique.values()].filter(
    (candidate) => !args.rejectedCandidateIds?.has(candidate.candidateId),
  );
  return {
    stateVersion: version,
    blockNumber: blockNumber.toString(),
    balances: (["ETH", "USDC", "UP", "DG"] as const).map((asset) =>
      assetAmount(
        asset,
        balances[asset],
        assetDecimals[asset],
        tokenFor(asset),
      ),
    ),
    candidates: rankCandidates(filtered),
    ownerBlockers,
    fatalBlockers,
  };
}

export async function executeCandidate(args: {
  candidate: ActionCandidate;
  expectedStateVersion: string;
  wallet: AgentWallet;
  config: RunnerConfig;
  onTransactionSubmitted?: ActionContext["onTransactionSubmitted"];
}) {
  const candidate = actionCandidateSchema.parse(args.candidate);
  if (candidate.stateVersion !== args.expectedStateVersion) {
    return actionResultSchema.parse({
      status: "state_changed",
      code: "STALE_CANDIDATE",
      message: "The candidate was derived from older state.",
    });
  }
  if (candidate.expiresAt && Date.parse(candidate.expiresAt) <= Date.now()) {
    return actionResultSchema.parse({
      status: "state_changed",
      code: "QUOTE_EXPIRED",
      message: "The candidate quote expired.",
    });
  }
  const action = actionByName(candidate.actionName);
  if (
    !action ||
    action.version !== candidate.actionVersion ||
    !action.inputSchema ||
    !action.analyze
  ) {
    return actionResultSchema.parse({
      status: "fatal_error",
      code: "ACTION_VERSION_UNAVAILABLE",
      message: "The candidate action is unavailable.",
    });
  }
  const input = action.inputSchema.parse(candidate.input);
  let currentAnalysis: ActionAnalysis;
  try {
    currentAnalysis = await action.analyze(
      {
        wallet: args.wallet,
        config: args.config,
        purpose: candidate.purpose,
        stateVersion: candidate.stateVersion,
      },
      input,
    );
  } catch (error) {
    return actionResultSchema.parse({
      status: "retryable_error",
      code: "REVALIDATION_UNAVAILABLE",
      message:
        error instanceof Error
          ? error.message
          : "Candidate revalidation was unavailable.",
      retryClass: "rpc",
      retryAfterMs: 1_000,
    });
  }
  if (
    !currentAnalysis.executableNow ||
    analysisState(currentAnalysis) !== analysisState(candidate.analysis)
  ) {
    return actionResultSchema.parse({
      status: "state_changed",
      code: "STALE_CANDIDATE",
      message: "The balances or protocol state changed after observation.",
    });
  }
  let result;
  try {
    result = await action.execute(
      {
        wallet: args.wallet,
        config: args.config,
        purpose: candidate.purpose,
        stateVersion: candidate.stateVersion,
        onTransactionSubmitted: args.onTransactionSubmitted,
      },
      input,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    if (normalized.includes("insufficient funds")) {
      return actionResultSchema.parse({
        status: "owner_required",
        code: "INSUFFICIENT_FUNDS",
        message,
      });
    }
    return actionResultSchema.parse({
      status: "state_changed",
      code: normalized.includes("cooldown")
        ? "PROTOCOL_COOLDOWN"
        : normalized.includes("paused")
          ? "PROTOCOL_PAUSED"
          : "SIMULATION_REJECTED",
      message,
    });
  }
  if (!("status" in result)) {
    return actionResultSchema.parse({
      status: "submitted",
      txHash: result.txHash,
      approvals: result.approvals ?? [],
    });
  }
  return actionResultSchema.parse(result);
}
