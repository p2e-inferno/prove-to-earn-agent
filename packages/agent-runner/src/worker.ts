import { randomUUID } from "crypto";
import { z } from "zod";
import { AgentSession } from "./session";
import { assertAgentNetwork } from "./network";
import { runDailyQuest, type RunReport } from "./run";
import { parseRunSpend } from "./spend";
import type { ActionTimelineEntry } from "./brain";
import type { AgentWallet, TransactionLifecycle } from "./wallet";
import type { X402PaymentLifecycle } from "./paid-fetch";
import type { RunnerConfig } from "./config";

/** Immediate in-process retries before the failure is persisted for later. */
const IMMEDIATE_RETRY_MS = [1_000, 4_000];
const PERSISTED_RETRY_BASE_MS = 30_000;
const PERSISTED_RETRY_CAP_MS = 300_000;
/** Discovery is the priciest read in the system, and runs are made once a day. */
const DISCOVERY_TTL_MS = 300_000;
/** A worker runs for days; its own history must not be what exhausts it. */
const MAX_TRACKED_CYCLES = 100;

export type FailureClass =
  | "retryable"
  | "agent_resolvable"
  | "time_dependent"
  | "owner_required"
  | "fatal";

const executionStatusSchema = z.enum([
  "planning",
  "running",
  "waiting_retry",
  "decision_required",
  "finalizing",
  "completed",
  "failed",
  "expired",
]);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

/** What the gateway returns when a lease is taken or recovered. */
const acquisitionSchema = z
  .object({
    outcome: z.enum(["acquired", "busy", "forbidden", "terminal", "waiting"]),
    execution_id: z.string().uuid().optional(),
    attempt_token: z.string().uuid().optional(),
    state_version: z.number().int().nonnegative().optional(),
    status: executionStatusSchema.optional(),
    checkpoint: z.record(z.unknown()).optional(),
    recovered: z.boolean().optional(),
  })
  .passthrough();

const checkpointSchema = z
  .object({
    outcome: z.string(),
    state_version: z.number().int().nonnegative().optional(),
    status: executionStatusSchema.optional(),
  })
  .passthrough();

export interface WorkerLease {
  executionId: string;
  attemptToken: string;
  stateVersion: number;
  status: ExecutionStatus;
  checkpoint: Record<string, unknown>;
  recovered: boolean;
}

export interface WorkerOptions {
  runId?: string;
  /** Stop after this many polls. Omitted means run until stopped. */
  maxCycles?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  requiredExecutionMode?: "owner_invoked" | "scheduled";
  decisionAuthority?: "platform_chat" | "delegated_client";
  commandId?: string;
  transactionLifecycle?(input: {
    candidate: import("./actions/types").ActionCandidate;
    transactionIndex: number;
    executionId: string;
    delegatedSelection: {
      frameId: string;
      fingerprint: string;
    };
  }): TransactionLifecycle;
  paymentLifecycle?(executionId: string): X402PaymentLifecycle;
}

export interface WorkerCycle {
  outcome:
    | "ran"
    | "busy"
    | "forbidden"
    | "terminal"
    | "no_work"
    | "waiting"
    | "continue"
    | "retry_scheduled"
    | "decision_required"
    | "network_failed";
  runId?: string;
  report?: RunReport;
  failureClass?: FailureClass;
  detail?: string;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Where a failure goes next.
 *
 * The distinction is operational, not cosmetic: a retryable fault should come
 * back in seconds, an owner-required one must stop and wait for a human, and a
 * fatal one must never be retried at all. Collapsing them is how a worker
 * either burns gas in a loop or silently abandons recoverable work.
 */
export function classifyFailure(code: string | undefined): FailureClass {
  if (!code) return "retryable";
  const normalized = code.toUpperCase();

  if (
    /TIMEOUT|RATE_LIMIT|UNREACHABLE|TRANSPORT|UNAVAILABLE|CONTENTION|IN_FLIGHT|LEASE/.test(
      normalized,
    )
  ) {
    return "retryable";
  }
  if (/APPROVAL_FAILED/.test(normalized)) {
    return "agent_resolvable";
  }
  if (/PAUSED|COOLDOWN|PENDING|NOT_YET|TIME/.test(normalized)) {
    return "time_dependent";
  }
  if (
    /KEYHOLDER|OWNER|SELECTION_REQUIRED|CHECKIN_NOT_FOUND|ADDRESS_MISMATCH|INSUFFICIENT_(?:FUNDS|UP|DG|USDC|ETH)|TRIAL_EXHAUSTED|FUNDING|NOT_OWNED|PAYMENT_RECONCILIATION/.test(
      normalized,
    )
  ) {
    return "owner_required";
  }
  if (
    /UNSUPPORTED|INVALID|NOT_FOUND|ALREADY_SELECTED|NOTHING_EXECUTABLE|REVOKED|EXPIRED|FORBIDDEN/.test(
      normalized,
    )
  ) {
    return "fatal";
  }
  return "retryable";
}

/** Exponential from 30s, capped at 5 minutes. */
export function retryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(
    PERSISTED_RETRY_BASE_MS * 2 ** exponent,
    PERSISTED_RETRY_CAP_MS,
  );
}

function statusForFailure(failure: FailureClass): ExecutionStatus {
  if (failure === "owner_required") return "decision_required";
  if (failure === "fatal") return "failed";
  return "waiting_retry";
}

/**
 * Durable execution of one run, holding a lease the whole time.
 *
 * The lease is what makes a second worker safe: it receives `busy` rather than
 * racing, and an expired lease is recoverable precisely because every effect
 * underneath is already idempotent.
 */
export class AgentWorker {
  private readonly session: AgentSession;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private renewals = 0;
  private renewalFailed = false;
  private discovery: { at: number; runId: string | null } | null = null;
  private readonly finishedRunIds = new Set<string>();

  constructor(
    private readonly wallet: AgentWallet,
    private readonly config: RunnerConfig,
    private readonly options: WorkerOptions = {},
  ) {
    this.session = new AgentSession(wallet, config);
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  /** Startup gate: nothing runs until the chain is the one we think it is. */
  async preflight(): Promise<void> {
    await assertAgentNetwork(this.wallet, this.config);
    if (this.options.requiredExecutionMode) {
      const mode = await this.session.executionMode();
      if (mode !== this.options.requiredExecutionMode) {
        throw new Error(
          `Agent execution mode is ${mode}, not ${this.options.requiredExecutionMode}`,
        );
      }
    }
  }

  private async acquire(runId: string): Promise<WorkerLease | WorkerCycle> {
    const response = await this.session.call<Record<string, unknown>>(
      `/api/agent/v1/quests/${runId}/execution`,
      {
        method: "POST",
        idempotencyKey: `execution-acquire:${runId}:${this.wallet.address}`,
        body: { operation: "acquire" },
      },
    );

    if (!response.ok) {
      if (response.code === "EXECUTION_BUSY") return { outcome: "busy", runId };
      if (response.code === "EXECUTION_FORBIDDEN") {
        return { outcome: "forbidden", runId };
      }
      return {
        outcome: "retry_scheduled",
        runId,
        failureClass: classifyFailure(response.code),
        detail: response.message,
      };
    }

    const parsed = acquisitionSchema.safeParse(
      (response.data as { execution?: unknown })?.execution ?? response.data,
    );
    if (!parsed.success) {
      return {
        outcome: "retry_scheduled",
        runId,
        failureClass: "retryable",
        detail: "The execution lease response could not be read.",
      };
    }

    const data = parsed.data;
    if (data.outcome === "busy") return { outcome: "busy", runId };
    if (data.outcome === "forbidden") return { outcome: "forbidden", runId };
    if (data.outcome === "terminal") return { outcome: "terminal", runId };
    // Backed off, or waiting on its owner. The server owns that decision so
    // every worker honours it identically.
    if (data.outcome === "waiting") return { outcome: "waiting", runId };
    if (!data.execution_id || !data.attempt_token) {
      return {
        outcome: "retry_scheduled",
        runId,
        failureClass: "retryable",
        detail: "The lease came back without an execution to work on.",
      };
    }

    return {
      executionId: data.execution_id,
      attemptToken: data.attempt_token,
      stateVersion: data.state_version ?? 0,
      status: data.status ?? "planning",
      checkpoint: data.checkpoint ?? {},
      recovered: data.recovered ?? false,
    };
  }

  private async checkpoint(
    runId: string,
    lease: WorkerLease,
    patch: {
      status: ExecutionStatus;
      checkpoint: Record<string, unknown>;
      nextRetryAt?: string | null;
      pendingDecision?: Record<string, unknown> | null;
      decisionDeadline?: string | null;
      lastError?: Record<string, unknown> | null;
      releaseLease?: boolean;
    },
  ): Promise<boolean> {
    if (this.renewalFailed) throw new Error("Execution lease renewal failed");
    const response = await this.session.call<Record<string, unknown>>(
      `/api/agent/v1/quests/${runId}/execution`,
      {
        method: "POST",
        idempotencyKey: `execution-checkpoint:${lease.executionId}:${lease.attemptToken}:${lease.stateVersion}`,
        body: {
          operation: "checkpoint",
          executionId: lease.executionId,
          attemptToken: lease.attemptToken,
          expectedVersion: lease.stateVersion,
          status: patch.status,
          checkpoint: patch.checkpoint,
          nextRetryAt: patch.nextRetryAt ?? null,
          pendingDecision: patch.pendingDecision ?? null,
          decisionDeadline: patch.decisionDeadline ?? null,
          lastError: patch.lastError ?? null,
          releaseLease: patch.releaseLease ?? false,
        },
      },
    );

    if (!response.ok) throw new Error("Execution checkpoint was rejected");
    const parsed = checkpointSchema.safeParse(
      (response.data as { execution?: unknown })?.execution ?? response.data,
    );
    if (!parsed.success || parsed.data.outcome !== "saved") {
      throw new Error("Execution checkpoint was not saved");
    }
    lease.stateVersion = parsed.data.state_version ?? lease.stateVersion + 1;
    return true;
  }

  /** Renew while work is in flight, so a long run never loses its own lease. */
  private startRenewal(runId: string, lease: WorkerLease): void {
    this.renewalFailed = false;
    const interval = this.config.leaseRenewMs ?? 40_000;
    this.renewTimer = setInterval(() => {
      // Its own operation, and its own idempotency key per beat: sharing the
      // checkpoint path made the heartbeat race the run's own terminal write.
      this.renewals += 1;
      void this.session
        .call(`/api/agent/v1/quests/${runId}/execution`, {
          method: "POST",
          idempotencyKey: `execution-renew:${lease.executionId}:${lease.attemptToken}:${this.renewals}`,
          body: {
            operation: "renew",
            executionId: lease.executionId,
            attemptToken: lease.attemptToken,
          },
        })
        .then((response) => {
          if (!response.ok) this.renewalFailed = true;
        })
        .catch(() => {
          this.renewalFailed = true;
        });
    }, interval);
    // A heartbeat must never be the reason a process refuses to exit.
    this.renewTimer.unref?.();
  }

  private stopRenewal(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
  }

  /** One full attempt at one run, from lease to checkpoint. */
  async runOnce(runId: string): Promise<WorkerCycle> {
    const acquired = await this.acquire(runId);
    if ("outcome" in acquired) return acquired;
    const lease = acquired;
    if (this.options.paymentLifecycle) {
      this.session.setPaymentLifecycle(
        this.options.paymentLifecycle(lease.executionId),
      );
    }

    // Consumed here, not carried forward: an answer applies to the attempt it
    // unblocked, and leaving it in the checkpoint would replay it every cycle.
    const { ownerResolution, delegatedSelection, ...carried } = lease.checkpoint;
    if (ownerResolution === "retry" && Array.isArray(carried.actionTimeline)) {
      carried.actionTimeline = (
        carried.actionTimeline as ActionTimelineEntry[]
      ).filter(
        (entry) => entry.status !== "broadcasting" || Boolean(entry.txHash),
      );
    }
    lease.checkpoint = carried;

    const attempts = Number(carried.attempts ?? 0);
    this.startRenewal(runId, lease);

    // The owner chose to stop retrying and take what the run has. Finalizing
    // secures the completion key; the unresolved reward stays recovery state.
    if (ownerResolution === "finalize") {
      try {
        return await this.finalize(runId, lease, carried);
      } finally {
        this.stopRenewal();
      }
    }

    try {
      let report: RunReport | null = null;
      let lastError: unknown = null;

      // Immediate retries cover a blip; anything past them is persisted so the
      // wait survives this process rather than being held in memory.
      for (
        let attempt = 0;
        attempt <= IMMEDIATE_RETRY_MS.length;
        attempt += 1
      ) {
        try {
          report = await runDailyQuest(this.wallet, this.config, {
            runId,
            restoredTimeline: Array.isArray(carried.actionTimeline)
              ? (carried.actionTimeline as ActionTimelineEntry[])
              : [],
            restoredSpend: parseRunSpend(carried.spend) ?? undefined,
            decisionAuthority: this.options.decisionAuthority,
            ...(this.options.paymentLifecycle ? { session: this.session } : {}),
            ...(delegatedSelection && typeof delegatedSelection === "object"
              ? {
                  delegatedSelection: delegatedSelection as {
                    candidateId: string;
                    candidateStateVersion: string;
                    fingerprint: string;
                  },
                }
              : {}),
            ...(this.options.transactionLifecycle &&
            delegatedSelection &&
            typeof delegatedSelection === "object"
              ? {
                  transactionLifecycle: (
                    candidate: import("./actions/types").ActionCandidate,
                    transactionIndex: number,
                  ) =>
                    this.options.transactionLifecycle!({
                      candidate,
                      transactionIndex,
                      executionId: lease.executionId,
                      delegatedSelection: delegatedSelection as {
                        frameId: string;
                        fingerprint: string;
                      },
                    }),
                }
              : {}),
            onProgress: async ({ actionTimeline, spend }) => {
              const retainKnownHash = () => {
                if (actionTimeline.at(-1)?.txHash) {
                  carried.actionTimeline = actionTimeline;
                }
              };
              let saved: boolean;
              try {
                saved = await this.checkpoint(runId, lease, {
                  status: "running",
                  checkpoint: { ...carried, actionTimeline, spend },
                });
              } catch (error) {
                retainKnownHash();
                throw error;
              }
              if (!saved) {
                retainKnownHash();
                throw new Error("Transaction checkpoint was not saved");
              }
              carried.actionTimeline = actionTimeline;
              carried.spend = spend;
            },
          });
          break;
        } catch (error) {
          lastError = error;
          const delay = IMMEDIATE_RETRY_MS[attempt];
          if (delay === undefined) break;
          await this.sleep(delay);
        }
      }

      if (!report) {
        const detail =
          lastError instanceof Error ? lastError.message : String(lastError);
        const nextAttempt = attempts + 1;
        await this.checkpoint(runId, lease, {
          status: "waiting_retry",
          checkpoint: { ...carried, attempts: nextAttempt },
          nextRetryAt: new Date(
            this.now() + retryDelayMs(nextAttempt),
          ).toISOString(),
          lastError: { code: "RUN_THREW", detail },
          releaseLease: true,
        });
        return {
          outcome: "retry_scheduled",
          runId,
          failureClass: "retryable",
          detail,
        };
      }

      const boundedContinuation =
        !report.succeeded && report.blockingCode === "CYCLE_BOUND_REACHED";
      const failure =
        report.succeeded || boundedContinuation
          ? null
          : classifyFailure(report.blockingCode);

      // Confirmed work is never discarded by a later failure: the checkpoint
      // records what landed, and only the unfinished part is retried.
      const checkpoint: Record<string, unknown> = {
        ...carried,
        attempts:
          failure && failure !== "fatal" && !boundedContinuation
            ? attempts + 1
            : attempts,
        questCompleted: report.questCompleted,
        settledTaskIds: report.tasks
          .filter((task) => task.status === "claimed")
          .map((task) => task.taskId),
        rewardPendingTaskIds: report.tasks
          .filter((task) => task.status === "reward_pending")
          .map((task) => task.taskId),
        actionTimeline: report.actionTimeline ?? [],
        lastRunAt: this.now(),
      };

      if (boundedContinuation) {
        await this.checkpoint(runId, lease, {
          status: "waiting_retry",
          checkpoint,
          nextRetryAt: new Date(this.now()).toISOString(),
          lastError: null,
          releaseLease: true,
        });
        return { outcome: "continue", runId, report };
      }

      if (!failure) {
        await this.checkpoint(runId, lease, {
          status: "completed",
          checkpoint,
          releaseLease: true,
        });
        return { outcome: "ran", runId, report };
      }

      // The deadline outranks the retry schedule: waiting past it loses the
      // key. A fatal run has nothing to secure, so it is never finalized here.
      if (report.blockingCode === "OWNER_REWARD_DECISION_REQUIRED") {
        const finalizedEarly = await this.finalizeBeforeDeadline(
          runId,
          lease,
          checkpoint,
          report,
        );
        if (finalizedEarly) return finalizedEarly;
      }

      const status = statusForFailure(failure);
      const nextAttempt = attempts + 1;
      const rewardDecision =
        report.blockingCode === "OWNER_REWARD_DECISION_REQUIRED";
      const runEndMs = report.runEndsAt ? Date.parse(report.runEndsAt) : NaN;
      const decisionDeadline =
        rewardDecision && Number.isFinite(runEndMs)
          ? new Date(
              runEndMs -
                (this.config.claimFinalizationBufferSeconds ?? 120) * 1000,
            ).toISOString()
          : null;
      const frameId = report.decisionFrameDraft ? randomUUID() : null;
      const expectedExecutionVersion = lease.stateVersion + 1;
      const frameCandidates = report.decisionFrameDraft?.candidates.map(
        (candidate) => ({
          candidateId: candidate.candidateId,
          frameId,
          expectedExecutionVersion,
          stateVersion: candidate.stateVersion,
          consequence: candidate.consequence,
          fingerprint: candidate.fingerprint,
          expiresAt: candidate.expiresAt,
          description: candidate.description,
          purpose: candidate.purpose,
          blockers: candidate.blockers,
        }),
      );
      const frameExpiresAt = frameCandidates?.reduce(
        (earliest, candidate) =>
          Date.parse(candidate.expiresAt) < Date.parse(earliest)
            ? candidate.expiresAt
            : earliest,
        frameCandidates[0]?.expiresAt ?? new Date(this.now()).toISOString(),
      );
      await this.checkpoint(runId, lease, {
        status,
        checkpoint,
        nextRetryAt:
          status === "waiting_retry"
            ? new Date(this.now() + retryDelayMs(nextAttempt)).toISOString()
            : null,
        pendingDecision:
          status === "decision_required"
            ? report.decisionFrameDraft && frameId
              ? {
                  version: 1,
                  kind: "action_selection",
                  frameId,
                  commandId: this.options.commandId,
                  executionId: lease.executionId,
                  expectedExecutionVersion,
                  candidates: frameCandidates,
                  expiresAt: frameExpiresAt,
                  balances: report.decisionFrameDraft.balances,
                  platformBlockers: report.decisionFrameDraft.platformBlockers,
                  ownerPolicyBlockers:
                    report.decisionFrameDraft.ownerPolicyBlockers,
                }
              : {
                // The resolver matches on this id, so a decision written
                // without one could never be answered by its owner.
                id: randomUUID(),
                code: report.blockingCode ?? "OWNER_ACTION_REQUIRED",
                question:
                  report.ownerQuestions?.[0]?.question ??
                  report.blockingReason ??
                  "This run needs you before the agent can continue.",
                options: rewardDecision
                  ? ["retry", "finalize"]
                  : ["retry", "cancel"],
                }
            : null,
        decisionDeadline: frameExpiresAt ?? decisionDeadline,
        lastError: {
          code: report.blockingCode ?? "UNKNOWN",
          detail: report.blockingReason ?? null,
        },
        releaseLease: true,
      });

      return {
        outcome:
          status === "decision_required"
            ? "decision_required"
            : "retry_scheduled",
        runId,
        report,
        failureClass: failure,
        detail: report.blockingReason,
      };
    } finally {
      this.stopRenewal();
    }
  }

  /**
   * Which run to work next, read through the same priced list the run uses.
   *
   * Cached, because that list is the top tier and a poll loop would otherwise
   * re-buy the same answer every interval for the whole day. A run already
   * finished is skipped outright rather than re-leased to be told so.
   */
  private async nextRunId(): Promise<string | null> {
    if (this.options.runId) {
      return this.finishedRunIds.has(this.options.runId)
        ? null
        : this.options.runId;
    }

    const cached = this.discovery;
    if (cached && this.now() - cached.at < DISCOVERY_TTL_MS) {
      if (!cached.runId || !this.finishedRunIds.has(cached.runId)) {
        return cached.runId;
      }
    }

    const list = await this.session.call<{
      runs: Array<Record<string, unknown>>;
    }>("/api/agent/v1/quests");
    if (!list.ok) return null;
    const eligible = (list.data?.runs ?? []).find(
      (run) =>
        (run.eligibility as { eligible?: boolean } | undefined)?.eligible &&
        !this.finishedRunIds.has(String(run.id)),
    );
    const runId = eligible ? String(eligible.id) : null;
    this.discovery = { at: this.now(), runId };
    return runId;
  }

  /**
   * Secure the completion key before the run closes.
   *
   * The per-task rewards are small next to the completion key and bonus, and
   * both are lost outright once the run ends. So inside the buffer the agent
   * stops retrying and finalizes with what it has, keeping the unresolved
   * reward as recovery state rather than reporting it as paid.
   */
  private async finalizeBeforeDeadline(
    runId: string,
    lease: WorkerLease,
    checkpoint: Record<string, unknown>,
    report: RunReport,
  ): Promise<WorkerCycle | null> {
    // Carried on the report, so learning the deadline costs no extra paid read.
    const deadline = report.runEndsAt ? Date.parse(report.runEndsAt) : NaN;
    if (!Number.isFinite(deadline)) return null;

    const bufferMs = (this.config.claimFinalizationBufferSeconds ?? 120) * 1000;
    if (this.now() < deadline - bufferMs) return null;

    return this.finalize(runId, lease, checkpoint, report);
  }

  /** Claim the completion key with whatever the run has, and stop retrying. */
  private async finalize(
    runId: string,
    lease: WorkerLease,
    checkpoint: Record<string, unknown>,
    report?: RunReport,
  ): Promise<WorkerCycle> {
    const finalized = await this.session.call<{ transactionHash?: string }>(
      `/api/agent/v1/quests/${runId}/complete`,
      { method: "POST", idempotencyKey: `finish:${runId}` },
    );

    await this.checkpoint(runId, lease, {
      status: finalized.ok ? "completed" : "failed",
      checkpoint: {
        ...checkpoint,
        finalizedAtDeadline: true,
        keyTxHash: finalized.data?.transactionHash ?? null,
      },
      lastError: finalized.ok
        ? null
        : {
            code: finalized.code ?? "FINALIZE_FAILED",
            detail: finalized.message ?? null,
          },
      releaseLease: true,
    });

    return {
      outcome: finalized.ok ? "ran" : "retry_scheduled",
      runId,
      ...(report ? { report } : {}),
      detail: finalized.ok
        ? "Finalized with an unresolved task reward rather than losing the key."
        : finalized.message,
    };
  }

  /**
   * Poll until stopped.
   *
   * Never throws: a worker that dies on an unexpected error stops doing every
   * other owner's work too, so a bad cycle is recorded and the loop continues.
   */
  async start(): Promise<WorkerCycle[]> {
    await this.preflight();

    const cycles: WorkerCycle[] = [];
    const interval = this.config.pollIntervalMs ?? 30_000;

    for (let cycle = 0; ; cycle += 1) {
      if (this.options.signal?.aborted) break;
      if (
        this.options.maxCycles !== undefined &&
        cycle >= this.options.maxCycles
      ) {
        break;
      }

      try {
        const runId = await this.nextRunId();
        cycles.push(
          runId ? await this.runOnce(runId) : { outcome: "no_work" as const },
        );
      } catch (error) {
        cycles.push({
          outcome: "retry_scheduled",
          failureClass: "retryable",
          detail: error instanceof Error ? error.message : String(error),
        });
      }

      // Only a permission failure ends the worker. A terminal run means today's
      // work is done, not that this process should stop serving the next one.
      const last = cycles[cycles.length - 1];
      if (last?.outcome === "terminal" && last.runId) {
        this.finishedRunIds.add(last.runId);
      }
      if (cycles.length > MAX_TRACKED_CYCLES) cycles.shift();
      if (last?.outcome === "forbidden") break;

      const isLastCycle =
        this.options.maxCycles !== undefined &&
        cycle + 1 >= this.options.maxCycles;
      if (!isLastCycle) await this.sleep(interval);
    }

    return cycles;
  }
}
