import { chatCompletion } from "@vendor/ai-client";
import { z } from "zod";
import type { AIConversationMessage } from "@vendor/ai-types";
import type { RunnerConfig } from "./config";
import type { AssetAmount } from "./actions/types";
import type { RunSpend } from "./spend";
import type { QuestCompletion } from "./report-schema";

export type { RunSpend } from "./spend";

export type TaskOutcome = {
  taskId: string;
  title: string;
  taskType: string;
  status: "completed" | "claimed" | "reward_pending" | "skipped" | "failed";
  /** What the market check found, or that it could not be made. */
  marketNote?: string;
  /** Machine code from the gateway, when the step reached it. */
  code?: string;
  detail?: string;
  txHash?: string;
  rewardAmount?: number;
  attestationUid?: string;
  attestationUrl?: string;
};

export interface RunFacts {
  runId: string | null;
  questTitle: string | null;
  agentAddress: string;
  walletProvider: string;
  tasks: TaskOutcome[];
  questCompleted: boolean;
  keyTxHash?: string | null;
  completion?: Omit<QuestCompletion, "txHash">;
  totalPaidCalls: number;
  discountedCalls: number;
  blockingReason?: string;
  /** Machine code for whatever stopped the run before any task ran. */
  blockingCode?: string;
  /** When this run closes, so a worker need not re-read the list to learn it. */
  runEndsAt?: string | null;
  /** What The Graph says this agent has already done on-chain. */
  historyNote?: string;
  /** Things the agent could not resolve for itself and needs the owner for. */
  ownerQuestions?: Array<{ question: string; blockedTaskId: string | null }>;
  /**
   * Every action executed this run, quest and prerequisite alike. A
   * prerequisite spends the owner's gas without completing a task, so it is
   * reported beside the tasks rather than hidden behind them.
   */
  actionTimeline?: ActionTimelineEntry[];
  spend?: RunSpend;
}

export interface ActionTimelineEntry {
  candidateId?: string;
  actionName: string;
  purpose: "quest_task" | "prerequisite";
  /** The task this served: completed by it, or unblocked by it. */
  taskId: string;
  status:
    | "broadcasting"
    | "submitted"
    | "confirmed"
    | "reverted"
    | "state_changed"
    | "retryable_error"
    | "fatal_error"
    | "owner_required";
  txHash?: string;
  detail?: string;
  principal?: AssetAmount;
  /** What landed in the agent wallet; null once the receipt showed nothing. */
  received?: AssetAmount | null;
  gasCostRaw?: string;
}

export interface RunNarrative {
  /** One line the owner sees first. */
  headline: string;
  /** A short paragraph explaining what happened and what to do. */
  summary: string;
  /** Concrete next actions, if any. */
  nextSteps: string[];
  source: "llm" | "deterministic";
}

const generatedNarrativeSchema = z
  .object({
    headline: z.string().min(1).max(500),
    summary: z.string().min(1).max(4000),
    nextSteps: z.array(z.string().min(1).max(500)).max(10).optional(),
  })
  .strict();

/**
 * Codes an owner can act on, mapped to what they should actually do.
 *
 * Kept explicit rather than left to the model: an agent that tells its owner
 * the wrong remedy is worse than one that says nothing, and these are the
 * cases where the right answer is already known.
 */
const REMEDIES: Record<string, string> = {
  INELIGIBLE:
    "The quest's entry requirements are not met — check GoodDollar verification and that the access pass is in a linked wallet.",
  TRIAL_EXHAUSTED:
    "Free trial runs are used up. A valid access pass is needed to keep earning from this quest.",
  ACCOUNT_FLAGGED:
    "The account is under review, so tasks and claims are paused. Contact support to resolve it.",
  DAILY_QUEST_WALLET_MISMATCH:
    "This run was started by a different wallet — another agent may already own it today.",
  REWARD_WALLET_MISMATCH:
    "This run is bound to a different payout wallet than this agent is configured for.",
  AGENT_CAPABILITY_DENIED:
    "This agent was not granted permission for that step. Update its permissions on the Agents page.",
  AGENT_REVOKED: "This agent has been revoked and will not act again.",
  SENDER_MISMATCH:
    "The transaction was sent from an address other than the agent's own wallet.",
  WRONG_ROUTER:
    "The swap did not go through the Uniswap Universal Router, so it cannot be verified.",
  ROUTE_MISMATCH: "The swap used different pools than the task requires.",
  TX_ALREADY_USED:
    "That transaction was already credited to another task and cannot be reused.",
  ATTESTATION_UNRESOLVED:
    "A previous reward attestation is still confirming. Retrying shortly should settle it.",
  INSUFFICIENT_FUNDS: "The agent wallet needs more ETH on Base to cover gas.",
  PAYMENT_REQUIRED:
    "The agent could not pay for the call — top up its USDC balance on Base.",
  GATEWAY_UNREACHABLE:
    "The P2E gateway could not be reached. Check the runner's P2E_GATEWAY_URL and that the service is up.",
  SESSION_FAILED:
    "The agent could not open a session. Confirm it is still registered and active on the Agents page.",
  AGENT_UNKNOWN:
    "This agent is not registered. Register it from the Agents page before running it.",
  INVALID_TASK_CONFIG:
    "This task is misconfigured, so nothing was sent on-chain. An admin needs to fix its pair, direction and amount.",
  DAILY_QUEST_PATH_ALREADY_SELECTED:
    "A different version of this quest was already started today, so this run cannot be entered. Nothing was sent on-chain.",
  START_FAILED:
    "The quest run could not be started. Nothing was sent on-chain; retrying later is safe.",
  UNSUPPORTED_ROUTE:
    "This task needs a multi-hop route the agent cannot build yet. It has to be done in the app.",
};

function deterministicNarrative(facts: RunFacts): RunNarrative {
  const done = facts.tasks.filter(
    (t) =>
      t.status === "completed" ||
      t.status === "claimed" ||
      t.status === "reward_pending",
  );
  const failed = facts.tasks.filter((t) => t.status === "failed");
  const skipped = facts.tasks.filter((t) => t.status === "skipped");

  const headline = facts.questCompleted
    ? `Completed ${facts.questTitle ?? "the daily quest"} — ${done.length}/${facts.tasks.length} tasks.`
    : done.length > 0
      ? `Partly done: ${done.length}/${facts.tasks.length} tasks on ${facts.questTitle ?? "the daily quest"}.`
      : `Could not start ${facts.questTitle ?? "the daily quest"}.`;

  const parts: string[] = [];
  if (done.length) {
    parts.push(
      `Finished ${done.map((t) => t.title).join(", ")}${
        done.some((t) => t.rewardAmount)
          ? ` and claimed ${done.reduce((n, t) => n + (t.rewardAmount ?? 0), 0)} xDG in task rewards`
          : ""
      }.`,
    );
  }
  if (failed.length) {
    parts.push(
      `Could not finish ${failed.map((t) => `${t.title} (${t.code ?? "unknown error"})`).join(", ")}.`,
    );
  }
  if (skipped.length) {
    parts.push(
      `Skipped ${skipped.map((t) => `${t.title} — ${t.detail ?? "not supported yet"}`).join(", ")}.`,
    );
  }
  if (facts.questCompleted && facts.keyTxHash) {
    parts.push(`The completion key was granted to the owner's wallet.`);
  } else if (!facts.questCompleted && done.length) {
    parts.push(
      "The quest was not finalized, so the completion key was not granted. Anything already claimed is kept.",
    );
  }
  if (facts.blockingReason) parts.push(facts.blockingReason);

  // Includes the blocking code: a run that never reached a task is exactly the
  // one whose owner has no other clue what to do.
  const nextSteps = Array.from(
    new Set(
      [
        ...(facts.ownerQuestions ?? []).map((q) => q.question),
        ...[...failed, ...skipped].map((t) =>
          t.code ? REMEDIES[t.code] : undefined,
        ),
        facts.blockingCode ? REMEDIES[facts.blockingCode] : undefined,
      ].filter((x): x is string => Boolean(x)),
    ),
  );

  return {
    headline,
    summary: parts.join(" "),
    nextSteps,
    source: "deterministic",
  };
}

/**
 * Explain the run to its owner.
 *
 * The deterministic narrative is always computed first and is what ships if the
 * model is unavailable or slow — an agent that goes quiet because its LLM call
 * failed is the failure mode this exists to prevent.
 */
export async function narrateRun(
  config: RunnerConfig,
  facts: RunFacts,
): Promise<RunNarrative> {
  const fallback = deterministicNarrative(facts);
  // `chatCompletion` throws on a missing key rather than returning an error
  // result, so the guard has to come first for this to stay non-throwing.
  if (!process.env.OPENROUTER_API_KEY) return fallback;

  const messages: AIConversationMessage[] = [
    {
      role: "system",
      content: [
        "You report to the human who owns an autonomous on-chain agent.",
        "Explain plainly what the agent did and what, if anything, the owner must do.",
        "Never invent transactions, amounts or outcomes not present in the facts.",
        "Amounts earned in-app are xDG. Only settled on-chain payouts are DG.",
        "Reply as JSON: { headline: string, summary: string, nextSteps: string[] }.",
        "headline is one sentence. summary is at most three sentences.",
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify({ facts, knownRemedies: fallback.nextSteps }),
    },
  ];

  try {
    const result = await chatCompletion({
      messages,
      model: config.llmModel,
      temperature: 0.2,
      maxTokens: 700,
      responseFormat: { type: "json_object" },
    });

    if (!result.success || !("content" in result) || !result.content) {
      return fallback;
    }

    const parsed = generatedNarrativeSchema.safeParse(
      JSON.parse(result.content),
    );
    if (!parsed.success) return fallback;

    return {
      headline: parsed.data.headline,
      summary: parsed.data.summary,
      nextSteps: parsed.data.nextSteps ?? fallback.nextSteps,
      source: "llm",
    };
  } catch {
    return fallback;
  }
}
