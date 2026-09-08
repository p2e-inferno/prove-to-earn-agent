import { EAS } from "@ethereum-attestation-service/eas-sdk";
import { ethers } from "ethers";
import { z } from "zod";
import { AgentSession } from "./session";
import {
  narrateRun,
  type ActionTimelineEntry,
  type RunFacts,
  type TaskOutcome,
} from "./brain";
import { fetchAgentHistory, summarizeHistory } from "./graph";
import {
  planAndExecute,
  type OwnerQuestion,
  type PlannerResult,
} from "./planner";
import {
  executeCandidate as executeBoundCandidate,
  observeCandidates,
} from "./candidates";
import { actionForTaskType } from "./actions/registry";
import { resultTxHash, type BoundAction } from "./actions/types";
import type { AgentWallet } from "./wallet";
import type { RunnerConfig } from "./config";

export interface RunOptions {
  runId?: string;
  dryRun?: boolean;
  restoredTimeline?: ActionTimelineEntry[];
  onProgress?(progress: {
    actionTimeline: ActionTimelineEntry[];
  }): Promise<void>;
}

export interface RunReport extends RunFacts {
  narrative: Awaited<ReturnType<typeof narrateRun>>;
  succeeded: boolean;
}

type QuestTask = {
  id: string;
  title?: string | null;
  task_type?: string | null;
  task_config?: Record<string, unknown> | null;
};

/** One row of the server's record of what this owner has already done today. */
type RunCompletion = {
  id?: string;
  daily_quest_run_task_id?: string;
  submission_status?: string;
  reward_claimed?: boolean;
};

const questListSchema = z
  .object({
    runs: z.array(
      z
        .object({
          id: z.union([z.string(), z.number()]),
          ends_at: z.string().datetime().nullable().optional(),
          eligibility: z
            .object({ eligible: z.boolean().optional() })
            .passthrough()
            .optional(),
          template: z.record(z.unknown()).nullable().optional(),
          daily_quest_run_tasks: z
            .array(
              z
                .object({
                  id: z.string().min(1),
                  title: z.string().nullable().optional(),
                  task_type: z.string().nullable().optional(),
                  task_config: z.record(z.unknown()).nullable().optional(),
                })
                .passthrough(),
            )
            .default([]),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const runDetailSchema = z
  .object({
    completions: z.array(
      z
        .object({
          id: z.string().optional(),
          daily_quest_run_task_id: z.string().optional(),
          submission_status: z.string().optional(),
          reward_claimed: z.boolean().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/**
 * One autonomous pass over a daily quest.
 *
 * Every task is attempted, and a task that cannot be done does not end the run:
 * the agent records why, claims what it did finish, and reports the whole
 * picture to its owner. Stopping silently halfway is the behaviour this
 * structure exists to prevent.
 */
export async function runDailyQuest(
  wallet: AgentWallet,
  config: RunnerConfig,
  options: RunOptions = {},
): Promise<RunReport> {
  const session = new AgentSession(wallet, config);
  const tasks: TaskOutcome[] = [];
  let paidCalls = 0;
  let discountedCalls = 0;
  let questCompleted = false;
  let keyTxHash: string | null = null;
  let blockingReason: string | undefined;
  let blockingCode: string | undefined;
  let questTitle: string | null = null;
  let runId: string | null = options.runId ?? null;
  let historyNote: string | undefined;
  let runEndsAt: string | null = null;
  let ownerQuestions: OwnerQuestion[] = [];
  const timeline: ActionTimelineEntry[] = [...(options.restoredTimeline ?? [])];

  const track = <T extends { paid: boolean; discounted: boolean }>(r: T): T => {
    if (r.paid) paidCalls += 1;
    if (r.discounted) discountedCalls += 1;
    return r;
  };

  const finish = async (): Promise<RunReport> => {
    const facts: RunFacts = {
      runId,
      questTitle,
      agentAddress: wallet.address,
      walletProvider: wallet.provider,
      tasks,
      questCompleted,
      keyTxHash,
      totalPaidCalls: paidCalls,
      discountedCalls,
      blockingReason,
      blockingCode,
      runEndsAt,
      historyNote,
      ownerQuestions: ownerQuestions.length ? ownerQuestions : undefined,
      actionTimeline: timeline.length ? timeline : undefined,
    };
    const narrative = await narrateRun(config, facts);
    // A run that skipped everything did nothing; reporting it as a success is
    // how an owner stops reading the reports that matter.
    // 'reward_pending' is deliberately not a success: the work landed but the
    // owner has not been paid, and that needs someone to act.
    const succeeded =
      tasks.length > 0 &&
      tasks.every(
        (t) => t.status !== "failed" && t.status !== "reward_pending",
      ) &&
      tasks.some((t) => t.status === "completed" || t.status === "claimed") &&
      !blockingCode;

    const report: RunReport = { ...facts, narrative, succeeded };
    if (!options.dryRun) await publishReport(session, report);
    return report;
  };

  const list = await track(
    await session.call<{ runs: Array<Record<string, unknown>> }>(
      "/api/agent/v1/quests",
    ),
  );
  if (!list.ok) {
    blockingCode = list.code;
    blockingReason = `Could not read available quests: ${list.code ?? list.message ?? "unknown error"}`;
    return finish();
  }

  const parsedList = questListSchema.safeParse(list.data);
  if (!parsedList.success) {
    blockingCode = "INVALID_GATEWAY_RESPONSE";
    blockingReason =
      "The quest list response was malformed, so no run was started.";
    return finish();
  }
  const runs = parsedList.data.runs;

  // An explicit run fails closed. Falling back to whatever else is eligible
  // would spend gas on a quest the caller did not ask for.
  if (options.runId) {
    const requested = runs.find((r) => r.id === options.runId);
    if (!requested) {
      blockingCode = "RUN_NOT_FOUND";
      blockingReason = `Run ${options.runId} was requested but is not open for this owner today.`;
      return finish();
    }
  }

  const target = options.runId
    ? runs.find((r) => r.id === options.runId)
    : runs.find(
        (r) => (r.eligibility as { eligible?: boolean } | undefined)?.eligible,
      );

  if (!target) {
    blockingReason =
      runs.length === 0
        ? "No daily quest runs are open right now."
        : "No open run is currently eligible for this owner.";
    return finish();
  }

  runId = String(target.id);
  runEndsAt = typeof target.ends_at === "string" ? target.ends_at : null;
  questTitle =
    ((target.template as Record<string, unknown> | null)?.title as string) ??
    null;

  const questTasks = target.daily_quest_run_tasks as QuestTask[];
  if (questTasks.length === 0) {
    blockingReason = "This run has no tasks configured.";
    return finish();
  }

  // Preflighted before the run is entered, not during it. Starting binds the
  // owner to this path for the day, so entering one the agent cannot finish
  // costs them the run they could have done by hand.
  const plan = questTasks
    .map((task) => planTask(task))
    .sort((a, b) => executionPriority(a) - executionPriority(b));

  if (!plan.some((step) => step.kind === "execute")) {
    for (const step of plan) {
      if (step.kind === "skip") tasks.push(step.outcome);
    }
    blockingCode = "NOTHING_EXECUTABLE";
    blockingReason =
      "No task in this run can be performed by this agent, so the run was not started.";
    return finish();
  }

  if (options.dryRun) {
    for (const step of plan) {
      tasks.push(
        step.kind === "skip"
          ? step.outcome
          : {
              taskId: step.task.id,
              title: step.title,
              taskType: step.taskType,
              status: "skipped",
              code: "DRY_RUN",
              detail:
                "Dry run — the quest was not started and nothing was sent.",
            },
      );
    }
    blockingCode = "DRY_RUN";
    blockingReason =
      "Dry run completed without changing server or chain state.";
    return finish();
  }

  const start = await track(
    await session.call(`/api/agent/v1/quests/${runId}/start`, {
      method: "POST",
      idempotencyKey: `start:${runId}:${wallet.address}`,
    }),
  );
  // Every failure blocks, including PATH_ALREADY_SELECTED: that code is raised
  // only when the owner already claimed a *different* run in this alternative
  // group today, so continuing would spend gas on a swap for a run they are
  // not on. A restart of this same run does not raise it.
  if (!start.ok) {
    blockingCode = start.code;
    blockingReason = `Could not start the run: ${start.message ?? start.code}`;
    tasks.push({
      taskId: "start",
      title: "Start the quest",
      taskType: "start",
      status: "failed",
      code: start.code,
      detail: start.message,
    });
    return finish();
  }

  // What the server already counts as done.
  //
  // This is the only safe answer to "has this task settled": the chain shows a
  // balance, not a credited task, and a checkpoint is this process's own memory
  // rather than the record the reward is paid from. Without it, a restart or a
  // retry re-sends an action that already landed and spends the owner's funds
  // twice.
  const settledTaskIds = new Set<string>();
  const unclaimedRewards = new Map<string, string>();

  const settled = await track(
    await session.call<{ completions?: RunCompletion[] }>(
      `/api/agent/v1/quests/${runId}`,
    ),
  );
  // Fails closed: acting without knowing what already landed is the one
  // mistake that costs real money, and a retry of this read is free of it.
  if (!settled.ok) {
    blockingCode = settled.code ?? "RECONCILE_FAILED";
    blockingReason = `Could not read what this run has already settled, so nothing was re-sent: ${settled.message ?? settled.code}`;
    return finish();
  }

  const parsedSettled = runDetailSchema.safeParse(settled.data);
  if (!parsedSettled.success) {
    blockingCode = "INVALID_GATEWAY_RESPONSE";
    blockingReason =
      "The run detail response was malformed, so nothing was re-sent.";
    return finish();
  }
  for (const completion of parsedSettled.data.completions as RunCompletion[]) {
    if (completion.submission_status !== "completed") continue;
    const taskId = completion.daily_quest_run_task_id;
    if (!taskId) continue;
    settledTaskIds.add(taskId);
    if (!completion.reward_claimed && completion.id) {
      unclaimedRewards.set(taskId, completion.id);
    }
  }

  const taskById = new Map(questTasks.map((task) => [task.id, task]));
  for (const taskId of settledTaskIds) {
    const task = taskById.get(taskId);
    if (!task) continue;
    const base = {
      taskId,
      title: String(task.title ?? task.task_type ?? taskId),
      taskType: String(task.task_type ?? "unknown"),
    };
    const completionId = unclaimedRewards.get(taskId);
    if (!completionId) {
      tasks.push({ ...base, status: "claimed" });
      continue;
    }
    // Verified earlier but never paid. Claiming is idempotent and needs no
    // transaction, so the reward is recovered without redoing the work.
    const recovered = await claimReward(
      session,
      wallet,
      config,
      completionId,
      track,
    );
    tasks.push(
      recovered.ok
        ? { ...base, status: "claimed", rewardAmount: recovered.rewardAmount }
        : {
            ...base,
            status: "reward_pending",
            code: recovered.code,
            detail: `Verified on an earlier attempt, but the reward claim failed and can be retried: ${recovered.detail ?? "unknown error"}`,
          },
    );
  }

  for (const entry of timeline) {
    if (
      (entry.status !== "submitted" && entry.status !== "confirmed") ||
      !entry.txHash
    ) {
      continue;
    }

    let receipt: Awaited<
      ReturnType<typeof wallet.publicClient.getTransactionReceipt>
    >;
    try {
      receipt = await wallet.publicClient.getTransactionReceipt({
        hash: entry.txHash as `0x${string}`,
      });
    } catch {
      blockingCode = "TX_CONFIRMATION_PENDING";
      blockingReason = `Transaction ${entry.txHash} is not final yet, so the agent will wait instead of replacing it.`;
      await options.onProgress?.({ actionTimeline: [...timeline] });
      return finish();
    }

    if (receipt.status !== "success") {
      entry.status = "reverted";
      entry.detail = "The submitted transaction reverted on-chain.";
      await options.onProgress?.({ actionTimeline: [...timeline] });
      continue;
    }

    entry.status = "confirmed";
    await options.onProgress?.({ actionTimeline: [...timeline] });
    if (entry.purpose !== "quest_task" || settledTaskIds.has(entry.taskId)) {
      continue;
    }

    const task = taskById.get(entry.taskId);
    if (!task) continue;
    const taskOutcome = await settleQuestTask({
      task,
      title: String(task.title ?? task.task_type ?? task.id),
      taskType: String(task.task_type ?? "unknown"),
      txHash: entry.txHash,
      wallet,
      config,
      session,
      runId,
      track,
    });
    tasks.push(taskOutcome);
    if (taskOutcome.status === "failed") {
      blockingCode = taskOutcome.code ?? "SETTLEMENT_FAILED";
      blockingReason =
        taskOutcome.detail ?? "A confirmed transaction could not be credited.";
      return finish();
    }
    settledTaskIds.add(entry.taskId);
  }

  // Read once, after the run is entered: it costs a paid query, and it is
  // context for the report rather than an input to any decision.
  let historyContext: Awaited<ReturnType<typeof fetchAgentHistory>> | undefined;
  try {
    historyContext = await fetchAgentHistory(wallet, config, track);
    historyNote = summarizeHistory(historyContext) ?? undefined;
  } catch {
    // Memory is a nicety; a run must never fail for want of it.
  }

  const executable = plan.filter(
    (step): step is Extract<PlannedTask, { kind: "execute" }> =>
      step.kind === "execute" && !settledTaskIds.has(step.task.id),
  );

  const candidateTasks = executable.map((step) => ({
    id: step.task.id,
    title: step.title,
    taskType: step.taskType,
    taskConfig: (step.task.task_config ?? {}) as Record<string, unknown>,
  }));

  // A candidate that produced no progress is not offered again; together with
  // the settled set above, that is what stops the planner looping on the same
  // action until the budget is gone.
  const rejectedCandidateIds = new Set<string>();

  // The agent sequences the run itself: one wallet has to satisfy several
  // tasks that spend different tokens, so the order — and any swap needed to
  // afford a later task — is reasoning, not a fixed list.
  const planned: PlannerResult | null =
    executable.length === 0
      ? null
      : await planAndExecute({
          config,
          tasks: candidateTasks,
          historyContext,
          observe: () =>
            observeCandidates({
              wallet,
              config,
              tasks: candidateTasks,
              settledTaskIds,
              rejectedCandidateIds,
            }),
          executeCandidate: async (candidate, expectedStateVersion) => {
            let submittedIndex = -1;
            const result = await executeBoundCandidate({
              candidate,
              expectedStateVersion,
              wallet,
              config,
              onTransactionSubmitted: async ({ txHash }) => {
                submittedIndex =
                  timeline.push({
                    candidateId: candidate.candidateId,
                    actionName: candidate.actionName,
                    purpose: candidate.purpose.kind,
                    taskId:
                      candidate.purpose.kind === "quest_task"
                        ? candidate.purpose.taskId
                        : candidate.purpose.forTaskId,
                    status: "submitted",
                    txHash,
                  }) - 1;
                await options.onProgress?.({ actionTimeline: [...timeline] });
              },
            });

            const txHash = resultTxHash(result);
            const entry = {
              candidateId: candidate.candidateId,
              actionName: candidate.actionName,
              purpose: candidate.purpose.kind,
              taskId:
                candidate.purpose.kind === "quest_task"
                  ? candidate.purpose.taskId
                  : candidate.purpose.forTaskId,
              status: result.status,
              ...(txHash ? { txHash } : {}),
              ...("message" in result ? { detail: result.message } : {}),
            } satisfies ActionTimelineEntry;
            if (submittedIndex >= 0) timeline[submittedIndex] = entry;
            else timeline.push(entry);
            await options.onProgress?.({ actionTimeline: [...timeline] });

            // A candidate that changed nothing must not be offered again, or the
            // planner can pick it forever without the run ever advancing.
            if (
              result.status !== "confirmed" &&
              result.status !== "submitted"
            ) {
              rejectedCandidateIds.add(candidate.candidateId);
              return { candidate, result };
            }

            // Only a quest task is submitted for verification. A prerequisite spends
            // gas to unblock a task and is never reported as completing one.
            const purpose = candidate.purpose;
            if (purpose.kind !== "quest_task") {
              return { candidate, result };
            }

            const step = executable.find(
              (item) => item.task.id === purpose.taskId,
            );
            if (!step) return { candidate, result };

            const taskOutcome = await settleQuestTask({
              task: step.task,
              title: step.title,
              taskType: step.taskType,
              txHash,
              wallet,
              config,
              session,
              runId,
              track,
            });
            settledTaskIds.add(step.task.id);
            return { candidate, result, taskOutcome };
          },
          askOwner: async () => {
            // Recorded in the report; the persistent worker is what turns this
            // into a durable decision the owner can answer later.
          },
        });

  ownerQuestions = planned?.questions ?? [];

  tasks.push(...(planned?.outcomes ?? []));
  for (const step of executable) {
    if (!tasks.some((t) => t.taskId === step.task.id)) {
      tasks.push({
        taskId: step.task.id,
        title: step.title,
        taskType: step.taskType,
        status: "skipped",
        code: "NOT_ATTEMPTED",
        detail: "The agent did not reach this task before it stopped.",
      });
    }
  }

  for (const step of plan) {
    if (step.kind === "skip") tasks.push(step.outcome);
  }

  const rewardPending = tasks.filter(
    (task) => task.status === "reward_pending",
  );
  if (rewardPending.length > 0) {
    blockingCode = "OWNER_REWARD_DECISION_REQUIRED";
    blockingReason =
      "Completed work is waiting on a reward claim. Retry the claim or finalize before the quest closes.";
    ownerQuestions.push({
      question:
        "Retry the pending reward claim, or finalize now and keep the completed quest without that reward?",
      blockedTaskId: rewardPending[0]!.taskId,
    });
    return finish();
  }

  const allDone = tasks.every(
    (t) => t.status === "completed" || t.status === "claimed",
  );

  if (!allDone) {
    // A task only its owner can resolve has to stop the run and say so. Left
    // uncoded it reads as a transient fault, and the worker then retries a run
    // that can never finish on its own — forever, at the owner's expense.
    // A skip with a reason outranks a failure: it is a determination about the
    // task, where a failure is an incident that may not recur. "Never reached"
    // is neither, so it is not a reason at all.
    const decided = tasks.find(
      (t) => t.status === "skipped" && t.code && t.code !== "NOT_ATTEMPTED",
    );
    const stuck = decided ?? tasks.find((t) => t.status === "failed");
    const actionFailure = planned?.actions
      .map((action) => action.result)
      .find(
        (result) =>
          result.status !== "confirmed" && result.status !== "submitted",
      );
    blockingCode ??=
      planned?.ownerBlockers[0]?.code ??
      planned?.fatalBlockers[0]?.code ??
      planned?.stopCode ??
      (actionFailure && "code" in actionFailure
        ? actionFailure.code
        : undefined) ??
      stuck?.code;
    blockingReason =
      "Some tasks were not completed, so the quest was not finalized and no completion key was granted.";
    return finish();
  }

  const finished = await track(
    await session.call<{ transactionHash?: string }>(
      `/api/agent/v1/quests/${runId}/complete`,
      { method: "POST", idempotencyKey: `finish:${runId}` },
    ),
  );

  if (finished.ok) {
    const parsed = z
      .object({ transactionHash: z.string().optional() })
      .passthrough()
      .safeParse(finished.data ?? {});
    if (!parsed.success) {
      blockingCode = "INVALID_GATEWAY_RESPONSE";
      blockingReason = "The quest completion response was malformed.";
      return finish();
    }
    questCompleted = true;
    keyTxHash = parsed.data.transactionHash ?? null;
  } else {
    blockingCode = finished.code;
    blockingReason = `Tasks are done but the quest could not be finalized: ${finished.message ?? finished.code}`;
  }

  return finish();
}

/**
 * Vendor state is order-dependent: a sell zeroes fuel, an upgrade needs fuel,
 * and lighting up earns it. Task order within a run is arbitrary and the
 * verifier checks each task independently, so the agent picks an order that
 * does not strand one task on another's side effect.
 */

const ACTION_ORDER = [
  "vendor_buy",
  "vendor_light_up",
  "vendor_level_up",
  "uniswap_swap",
  "vendor_sell",
];

function executionPriority(step: PlannedTask): number {
  const taskType =
    step.kind === "execute" ? step.taskType : step.outcome.taskType;
  const index = ACTION_ORDER.indexOf(taskType);
  return index === -1 ? ACTION_ORDER.length : index;
}

type PlannedTask =
  | { kind: "skip"; outcome: TaskOutcome }
  | {
      kind: "execute";
      task: QuestTask;
      title: string;
      taskType: string;
      action: BoundAction;
      input: unknown;
    };

/** Everything decidable without spending money or gas. */
function planTask(task: QuestTask): PlannedTask {
  const taskType = String(task.task_type ?? "unknown");
  const title = String(task.title ?? taskType);
  const base = { taskId: task.id, title, taskType };

  const action = actionForTaskType(taskType);
  if (!action) {
    return {
      kind: "skip",
      outcome: {
        ...base,
        status: "skipped",
        code: "OWNER_ACTION_REQUIRED",
        detail: `This agent cannot perform '${taskType}' yet; it needs to be done in the app.`,
      },
    };
  }

  // Parsed rather than defaulted: guessing an amount or direction would send a
  // real transaction with the wrong terms, which then fails verification
  // anyway. The shape mirrors the verifier's own INVALID_TASK_CONFIG check.
  const parsed = action.parse(task.task_config);
  if (!parsed.ok) {
    return {
      kind: "skip",
      outcome: {
        ...base,
        status: "skipped",
        code: "INVALID_TASK_CONFIG",
        detail: parsed.reason,
      },
    };
  }

  return {
    kind: "execute",
    task,
    title,
    taskType,
    action,
    input: parsed.input,
  };
}

/**
 * Turn a confirmed on-chain action into a settled quest task.
 *
 * Split from execution because a candidate the planner ran and a task the
 * fallback ran reach this identically, and because only a `quest_task` purpose
 * gets here at all — a prerequisite spends gas without ever being submitted as
 * a completion.
 */
async function settleQuestTask(args: {
  task: QuestTask;
  title: string;
  taskType: string;
  txHash: string | null;
  marketNote?: string;
  wallet: AgentWallet;
  config: RunnerConfig;
  session: AgentSession;
  runId: string;
  track: <T extends { paid: boolean; discounted: boolean }>(r: T) => T;
}): Promise<TaskOutcome> {
  const { task, title, taskType, txHash, marketNote } = args;
  const { wallet, config, session, runId, track } = args;
  const base = { taskId: task.id, title, taskType };

  const completed = track(
    await session.call<{ completionId: string }>(
      "/api/agent/v1/tasks/complete",
      {
        method: "POST",
        idempotencyKey: txHash
          ? `complete:${txHash}`
          : `complete:${runId}:${task.id}`,
        body: {
          dailyQuestRunId: runId,
          dailyQuestRunTaskId: task.id,
          transactionHash: txHash,
        },
      },
    ),
  );

  if (!completed.ok) {
    return {
      ...base,
      status: "failed",
      code: completed.code,
      detail: completed.message,
      ...(txHash ? { txHash } : {}),
    };
  }

  const parsedCompletion = z
    .object({ completionId: z.string().min(1).optional() })
    .passthrough()
    .safeParse(completed.data ?? {});
  if (!parsedCompletion.success) {
    return {
      ...base,
      status: "failed",
      code: "INVALID_GATEWAY_RESPONSE",
      detail: "The task completion response was malformed.",
      ...(txHash ? { txHash } : {}),
    };
  }
  const completionId = parsedCompletion.data.completionId;
  if (!completionId) {
    return {
      ...base,
      status: "completed",
      ...(txHash ? { txHash } : {}),
      marketNote,
    };
  }

  // The task is already credited at this point. A claim failure downgrades the
  // outcome but must not discard the completion.
  const claimed = await claimReward(
    session,
    wallet,
    config,
    completionId,
    track,
  );
  // Verified on-chain and credited, but the xDG is not in the owner's hands.
  // Reporting that as completed tells them they were paid when they were not;
  // the claim is idempotent, so this state is the retry signal.
  if (!claimed.ok) {
    return {
      ...base,
      status: "reward_pending",
      code: claimed.code,
      detail: `Task verified, but the reward claim failed and can be retried: ${claimed.detail ?? "unknown error"}`,
      ...(txHash ? { txHash } : {}),
      marketNote,
    };
  }

  return {
    ...base,
    status: "claimed",
    ...(txHash ? { txHash } : {}),
    rewardAmount: claimed.rewardAmount,
    marketNote,
  };
}

const CLAIM_ATTEMPTS = 3;
const CLAIM_BACKOFF_MS = [1_000, 4_000];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A claim worth sending again: transport, contention, or a pending receipt. */
function isRetryableClaimFailure(result: {
  status: number;
  code?: string;
  retryable?: boolean;
}): boolean {
  if (result.retryable) return true;
  if (result.status === 0 || result.status >= 500) return true;
  if (result.status === 409) return true;
  return result.code === "ATTESTATION_UNRESOLVED";
}

/**
 * Two-step by design: the server returns exactly what to sign, so the agent
 * never reconstructs EAS encoding from the web client.
 */
async function claimReward(
  session: AgentSession,
  wallet: AgentWallet,
  config: RunnerConfig,
  completionId: string,
  track: <T extends { paid: boolean; discounted: boolean }>(r: T) => T,
): Promise<{
  ok: boolean;
  code?: string;
  detail?: string;
  rewardAmount?: number;
}> {
  const idempotencyKey = `claim:${completionId}`;

  // Retried, because the reward is only claimable while the run window is open
  // and nothing else will try again before it closes. The key is stable, so the
  // gateway settles the original attempt rather than charging for each retry.
  const submitClaim = async (
    attestationSignature?: Record<string, unknown>,
  ) => {
    let last!: Awaited<
      ReturnType<typeof session.call<{ rewardAmount?: number }>>
    >;

    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      last = track(
        await session.call<{ rewardAmount?: number }>(
          "/api/agent/v1/tasks/claim",
          {
            method: "POST",
            idempotencyKey,
            body: attestationSignature
              ? { completionId, attestationSignature }
              : { completionId },
          },
        ),
      );

      if (last.ok || !isRetryableClaimFailure(last)) return last;
      if (attempt < CLAIM_ATTEMPTS - 1) await delay(CLAIM_BACKOFF_MS[attempt]!);
    }

    return last;
  };

  const intentResponse = track(
    await session.call<Record<string, unknown>>(
      `/api/agent/v1/tasks/claim/${completionId}/intent`,
    ),
  );

  // Nothing to attest on this deployment, so the claim stands on its own.
  if (intentResponse.code === "EAS_DISABLED") {
    const unsigned = await submitClaim();
    const parsed = z
      .object({ rewardAmount: z.number().finite().optional() })
      .passthrough()
      .safeParse(unsigned.data ?? {});
    return {
      ok: unsigned.ok,
      code: unsigned.code,
      detail: unsigned.message,
      rewardAmount: parsed.success ? parsed.data.rewardAmount : undefined,
    };
  }

  const parsedIntent = z
    .object({
      easContractAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      chainId: z.union([
        z.number().int().positive(),
        z.string().regex(/^\d+$/),
      ]),
      network: z.string().min(1),
      request: z
        .object({
          schema: z.string().min(1),
          recipient: z.string().min(1),
          expirationTime: z
            .union([z.string(), z.number(), z.bigint()])
            .optional(),
          revocable: z.boolean(),
          refUID: z.string().min(1),
          data: z.string().min(1),
          deadline: z.union([z.string(), z.number(), z.bigint()]),
        })
        .passthrough(),
    })
    .passthrough()
    .safeParse(intentResponse.intent);
  if (!parsedIntent.success) {
    return {
      ok: false,
      code: intentResponse.code ?? "INVALID_GATEWAY_RESPONSE",
      detail: intentResponse.message ?? "no signing intent returned",
    };
  }
  const intent = parsedIntent.data;

  try {
    const request = intent.request;
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    const eas = new EAS(String(intent.easContractAddress));
    eas.connect(provider);

    // A shim signer rather than a raw key: the EAS SDK builds the exact typed
    // data (domain, types, nonce, version) and the wallet signs it, so a
    // CDP-custodied agent works identically to a local one and neither path
    // hand-rolls EIP-712.
    const signer = {
      getAddress: async () => wallet.address,
      signTypedData: async (
        domain: Record<string, unknown>,
        types: Record<string, unknown>,
        value: Record<string, unknown>,
      ) => {
        const primaryType =
          Object.keys(types).find((key) => key !== "EIP712Domain") ?? "Attest";
        return wallet.signTypedData({
          domain,
          types,
          primaryType,
          message: value,
        });
      },
    };

    const delegated = await eas.getDelegated();
    const response = await delegated.signDelegatedAttestation(
      {
        schema: String(request.schema),
        recipient: String(request.recipient),
        expirationTime: BigInt(String(request.expirationTime ?? "0")),
        revocable: Boolean(request.revocable),
        refUID: String(request.refUID),
        data: String(request.data),
        deadline: BigInt(String(request.deadline)),
        value: 0n,
      },
      signer as never,
    );

    const signature =
      typeof response.signature === "string"
        ? response.signature
        : ethers.Signature.from(response.signature as never).serialized;

    const submitted = await submitClaim({
      signature,
      attester: wallet.address,
      recipient: String(request.recipient),
      schemaUid: String(request.schema),
      data: String(request.data),
      deadline: String(request.deadline),
      expirationTime: String(request.expirationTime ?? "0"),
      revocable: Boolean(request.revocable),
      refUID: String(request.refUID),
      chainId: Number(intent.chainId),
      network: String(intent.network),
    });

    const parsed = z
      .object({ rewardAmount: z.number().finite().optional() })
      .passthrough()
      .safeParse(submitted.data ?? {});
    return {
      ok: submitted.ok,
      code: submitted.code,
      detail: submitted.message,
      rewardAmount: parsed.success ? parsed.data.rewardAmount : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      code: "ATTESTATION_SIGNING_FAILED",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Reporting is unpriced and best-effort: an owner must still learn what
 * happened even when the agent ran out of funds or lost its permissions.
 */
async function publishReport(
  session: AgentSession,
  report: RunReport,
): Promise<void> {
  try {
    await session.call("/api/agent/v1/reports", {
      method: "POST",
      idempotencyKey: `report:${report.runId ?? "none"}:${Date.now()}`,
      body: {
        dailyQuestRunId: report.runId,
        succeeded: report.succeeded,
        questCompleted: report.questCompleted,
        headline: report.narrative.headline,
        summary: report.narrative.summary,
        nextSteps: report.narrative.nextSteps,
        narrativeSource: report.narrative.source,
        tasks: report.tasks,
        actions: report.actionTimeline ?? [],
        executionState: report.succeeded
          ? "completed"
          : report.ownerQuestions?.length
            ? "decision_required"
            : "failed",
        paidCalls: report.totalPaidCalls,
        discountedCalls: report.discountedCalls,
        blockingReason: report.blockingReason ?? null,
        ownerQuestions: report.ownerQuestions ?? [],
      },
    });
  } catch {
    // Never let reporting failure mask the run's own outcome.
  }
}
