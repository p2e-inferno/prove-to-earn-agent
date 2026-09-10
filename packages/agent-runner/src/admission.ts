import { formatEther, formatUnits, parseUnits } from "viem";
import { priceFor } from "@/packages/agent-gateway/src/payments/pricing";
import { readBalances, GAS_RESERVE_WEI } from "./balances";
import { observeCandidates } from "./candidates";
import { actionForTaskType } from "./actions/registry";
import type { AgentWallet } from "./wallet";
import type { RunnerConfig } from "./config";

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
  const balances = await readBalances(wallet);
  const gasPrice = await wallet.publicClient.getGasPrice();
  const gasBudget =
    gasPrice *
      BigInt((tasks.length + (config.maxFundingSwaps ?? 20)) * 3) *
      1_000_000n +
    GAS_RESERVE_WEI;
  const price = (id: string) => parseUnits(priceFor(id).slice(1), 6);
  const cycles = BigInt(tasks.length + (config.maxFundingSwaps ?? 20) + 2);
  const apiBudget =
    cycles * (price("quests.list") + price("quests.detail")) +
    price("quests.start") +
    price("quests.complete") +
    BigInt(tasks.length) *
      (price("tasks.complete") +
        price("tasks.claim.intent") +
        price("tasks.claim"));
  const required = { ETH: gasBudget, USDC: apiBudget, UP: 0n, DG: 0n };
  for (const task of tasks) {
    const action = actionForTaskType(task.taskType);
    if (!action?.analyze || !action.parseTaskConfig)
      return "A task is not supported by this agent.";
    const analysis = await action.analyze(
      {
        wallet,
        config,
        purpose: { kind: "quest_task", taskId: task.id },
        stateVersion: "admission",
      },
      action.parseTaskConfig(task.taskConfig),
    );
    for (const requirement of analysis.requirements) {
      if (requirement.reference.kind === "asset")
        required[requirement.reference.asset] += BigInt(
          requirement.reference.requiredRaw,
        );
    }
  }
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
  const observation = await observeCandidates({ wallet, config, tasks });
  return (
    observation.fatalBlockers[0]?.message ??
    observation.ownerBlockers[0]?.message ??
    null
  );
}
