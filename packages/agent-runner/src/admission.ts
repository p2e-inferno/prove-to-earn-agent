import { formatEther, formatUnits, parseUnits } from "viem";
import { priceFor } from "@/packages/agent-gateway/src/payments/pricing";
import { GAS_RESERVE_WEI } from "./balances";
import { observeCandidates } from "./candidates";
import type { Asset } from "./actions/types";
import type { AgentWallet } from "./wallet";
import type { RunnerConfig } from "./config";

/** A V3 router swap costs ~180k gas and an ERC-20 approve ~50k; this is either. */
const GAS_PER_OPERATION = 250_000n;

/** Absorbs a route changing between admission and execution. */
const GAS_SAFETY_FACTOR = 2n;

/** One swap and its approval close a shortfall; a second covers one reroute. */
const HOPS_PER_SHORTFALL = 2n;

/** quests.list is cached for DISCOVERY_TTL_MS, so a run pays it once per window. */
const DISCOVERY_WINDOWS = 2n;

/** Mirrors CLAIM_ATTEMPTS in run.ts: a reward claim can genuinely be paid for thrice. */
const CLAIM_ATTEMPT_BUDGET = 3n;

export async function checkAdmissionFunding(
  wallet: AgentWallet,
  config: RunnerConfig,
  run: Record<string, unknown>,
): Promise<string | null> {
  const tasks = (
    run.daily_quest_run_tasks as Array<{
      id: string;
      title: string;
      task_type: string;
      task_config: Record<string, unknown>;
    }>
  ).map((task) => ({
    id: task.id,
    title: task.title,
    taskType: task.task_type,
    taskConfig: task.task_config,
  }));
  // One observation answers every question this gate asks: it reads the wallet,
  // analyses each task, and surfaces the blockers. Running its analyze pass a
  // second time here cost an extra RPC round trip per task for no new fact.
  const [observation, gasPrice] = await Promise.all([
    observeCandidates({ wallet, config, tasks }),
    wallet.publicClient.getGasPrice(),
  ]);

  // A task that can never run is not a funding problem; say so before asking
  // the owner for money that would not fix it.
  if (observation.fatalBlockers[0]) return observation.fatalBlockers[0].message;

  const assets = ["ETH", "USDC", "UP", "DG"] as const;
  const balances = Object.fromEntries(
    observation.balances.map((balance) => [balance.asset, BigInt(balance.raw)]),
  ) as Record<Asset, bigint>;

  const price = (id: string) => parseUnits(priceFor(id).slice(1), 6);

  // A funding swap is an on-chain action and never reaches the gateway, so the
  // fee budget follows the quest's structure rather than any swap count.
  const apiBudget =
    DISCOVERY_WINDOWS * price("quests.list") +
    price("quests.start") +
    price("quests.complete") +
    BigInt(tasks.length) *
      (price("quests.detail") +
        price("tasks.complete") +
        CLAIM_ATTEMPT_BUDGET *
          (price("tasks.claim.intent") + price("tasks.claim")));

  const required = Object.fromEntries(
    assets.map((asset) => [asset, BigInt(observation.assetRequirements[asset])]),
  ) as Record<Asset, bigint>;
  required.USDC += apiBudget;

  // Gas scales with the operations this run actually needs: one per task, plus a
  // bounded hop allowance for each asset the wallet is genuinely short of. The
  // configured swap cap is a ceiling on behaviour and was never a forecast of it.
  const shortfalls = assets.filter(
    (asset) => required[asset] > balances[asset],
  ).length;
  const operations =
    BigInt(tasks.length) + BigInt(shortfalls) * HOPS_PER_SHORTFALL;
  required.ETH +=
    gasPrice * operations * GAS_PER_OPERATION * GAS_SAFETY_FACTOR +
    GAS_RESERVE_WEI;

  const deficits: string[] = [];
  if (balances.ETH < required.ETH)
    deficits.push(
      `${formatEther(required.ETH - balances.ETH)} ETH including the gas reserve`,
    );
  if (balances.USDC < required.USDC)
    deficits.push(
      `${formatUnits(required.USDC - balances.USDC, 6)} USDC including API payments`,
    );
  if (deficits.length) return `Funding required: ${deficits.join("; ")}.`;
  return observation.ownerBlockers[0]?.message ?? null;
}
