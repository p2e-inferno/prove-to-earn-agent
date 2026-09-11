import { formatUnits, parseUnits } from "viem";
import { z } from "zod";
import { AGENT_REASON_CODES } from "@/packages/agent-gateway/src/codes";
import { priceFor } from "@/packages/agent-gateway/src/payments/pricing";
import { GAS_RESERVE_WEI } from "./balances";
import { observeCandidates } from "./candidates";
import {
  assetAmount,
  type Asset,
  type AssetAmount,
  type ReadOnlyAgentWallet,
} from "./actions/types";
import type { RunnerConfig } from "./config";

const GAS_PER_OPERATION = 250_000n;
const GAS_SAFETY_FACTOR = 2n;
const HOPS_PER_SHORTFALL = 2n;
const DISCOVERY_WINDOWS = 2n;
const CLAIM_ATTEMPT_BUDGET = 3n;

const taskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().default("Quest task"),
    task_type: z.string().min(1),
    task_config: z.record(z.unknown()),
  })
  .passthrough();

export interface AdmissionBlocker {
  class: "invariant" | "owner" | "funding";
  code: string;
  message: string;
  taskId?: string;
}

export interface AdmissionAssessment {
  agentWallet: string;
  admissible: boolean;
  overridable: boolean;
  blockers: AdmissionBlocker[];
  funding: {
    required: AssetAmount[];
    held: AssetAmount[];
    deficits: AssetAmount[];
  };
  economics: {
    apiBudgetUsd: string;
    gasBudgetRaw: string;
    method: "heuristic" | "measured";
  };
  stateVersion: string;
}

export function blockedAdmission(
  walletAddress: string,
  blocker: Omit<AdmissionBlocker, "class"> & {
    class?: AdmissionBlocker["class"];
  },
): AdmissionAssessment {
  return {
    agentWallet: walletAddress.toLowerCase(),
    admissible: false,
    overridable: false,
    blockers: [{ class: blocker.class ?? "invariant", ...blocker }],
    funding: { required: [], held: [], deficits: [] },
    economics: {
      apiBudgetUsd: "0",
      gasBudgetRaw: "0",
      method: "heuristic",
    },
    stateVersion: "unavailable",
  };
}

function taskList(run: Record<string, unknown>) {
  return z
    .array(taskSchema)
    .min(1)
    .parse(run.daily_quest_run_tasks)
    .map((task) => ({
      id: task.id,
      title: task.title,
      taskType: task.task_type,
      taskConfig: task.task_config,
    }));
}

export async function assessAdmission(
  wallet: ReadOnlyAgentWallet,
  config: RunnerConfig,
  run: Record<string, unknown>,
): Promise<AdmissionAssessment> {
  const tasks = taskList(run);
  const [observation, gasPrice] = await Promise.all([
    observeCandidates({ wallet, config, tasks }),
    wallet.publicClient.getGasPrice(),
  ]);

  const assets = ["ETH", "USDC", "UP", "DG"] as const;
  const heldByAsset = Object.fromEntries(
    observation.balances.map((balance) => [balance.asset, balance]),
  ) as Record<Asset, AssetAmount>;
  const heldRaw = Object.fromEntries(
    assets.map((asset) => [asset, BigInt(heldByAsset[asset].raw)]),
  ) as Record<Asset, bigint>;
  const price = (id: string) => parseUnits(priceFor(id).slice(1), 6);
  const apiBudget =
    DISCOVERY_WINDOWS * price("quests.list") +
    price("quests.start") +
    price("quests.complete") +
    BigInt(tasks.length) *
      (price("quests.detail") +
        price("tasks.complete") +
        CLAIM_ATTEMPT_BUDGET *
          (price("tasks.claim.intent") + price("tasks.claim")));

  const requiredRaw = Object.fromEntries(
    assets.map((asset) => [
      asset,
      BigInt(observation.assetRequirements[asset]),
    ]),
  ) as Record<Asset, bigint>;
  requiredRaw.USDC += apiBudget;
  const shortfalls = assets.filter(
    (asset) => requiredRaw[asset] > heldRaw[asset],
  ).length;
  const operations =
    BigInt(tasks.length) + BigInt(shortfalls) * HOPS_PER_SHORTFALL;
  const gasBudget =
    gasPrice * operations * GAS_PER_OPERATION * GAS_SAFETY_FACTOR;
  requiredRaw.ETH += gasBudget + GAS_RESERVE_WEI;

  const required = assets.map((asset) =>
    assetAmount(
      asset,
      requiredRaw[asset],
      heldByAsset[asset].decimals,
      heldByAsset[asset].tokenAddress as `0x${string}` | null,
    ),
  );
  const deficits = assets
    .map((asset) => {
      const raw =
        requiredRaw[asset] > heldRaw[asset]
          ? requiredRaw[asset] - heldRaw[asset]
          : 0n;
      return assetAmount(
        asset,
        raw,
        heldByAsset[asset].decimals,
        heldByAsset[asset].tokenAddress as `0x${string}` | null,
      );
    })
    .filter((amount) => amount.raw !== "0");

  const blockers: AdmissionBlocker[] = [
    ...observation.fatalBlockers.map((blocker) => ({
      class: "invariant" as const,
      code: blocker.code,
      message: blocker.message,
      taskId: blocker.taskId,
    })),
    ...observation.ownerBlockers.map((blocker) => ({
      class: "owner" as const,
      code: blocker.code,
      message: blocker.message,
      taskId: blocker.taskId,
    })),
  ];

  if (observation.fatalBlockers.length === 0) {
    for (const asset of ["ETH", "USDC"] as const) {
      if (requiredRaw[asset] <= heldRaw[asset]) continue;
      const deficit = requiredRaw[asset] - heldRaw[asset];
      const formatted = assetAmount(
        asset,
        deficit,
        heldByAsset[asset].decimals,
        heldByAsset[asset].tokenAddress as `0x${string}` | null,
      ).formatted;
      blockers.push({
        class: "funding",
        code: AGENT_REASON_CODES.INSUFFICIENT_FUNDING,
        message:
          asset === "ETH"
            ? `The wallet needs ${formatted} more ETH including its gas reserve.`
            : `The wallet needs ${formatted} more USDC including API payments.`,
      });
    }
  }

  return {
    agentWallet: wallet.address.toLowerCase(),
    admissible: blockers.length === 0,
    overridable:
      blockers.length > 0 &&
      blockers.every((blocker) => blocker.class === "funding"),
    blockers,
    funding: {
      required,
      held: observation.balances,
      deficits,
    },
    economics: {
      apiBudgetUsd: formatUnits(apiBudget, 6),
      gasBudgetRaw: gasBudget.toString(),
      method: "heuristic",
    },
    stateVersion: observation.stateVersion,
  };
}
