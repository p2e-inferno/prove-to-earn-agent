import { createAgentAdminClient } from "@adapters/datastore";
import { z } from "zod";
import { getLogger } from "@vendor/logger";
import type { Json } from "@vendor/json";
import { runSpendSchema } from "@/packages/agent-runner/src/spend";
import {
  questCompletionSchema,
  reportActionSchema,
  reportTaskSchema,
} from "@/packages/agent-runner/src/report-schema";
import {
  ok,
  fail,
  type QuestPrincipal,
  type ServiceResult,
} from "@vendor/quests/principal";

const log = getLogger("quests:daily:services:reports");

const MAX_HEADLINE = 500;
const MAX_SUMMARY = 4000;
const MAX_STEPS = 10;
const MAX_TASKS = 50;
const MAX_ACTIONS = 50;
const MAX_OWNER_QUESTIONS = 10;
const ownerQuestionSchema = z
  .object({
    question: z.string().min(1).max(500),
    blockedTaskId: z.string().max(200).nullable(),
  })
  .strict();

const REPORT_COLUMNS =
  "id,agent_id,daily_quest_run_id,succeeded,quest_completed,headline,summary,next_steps,narrative_source,tasks,actions,owner_questions,execution_state,paid_calls,discounted_calls,blocking_reason,spend,completion,created_at,quest:daily_quest_runs(template:daily_quest_templates(title))";

export interface AgentRunReportInput {
  dailyQuestRunId?: string | null;
  succeeded?: boolean;
  questCompleted?: boolean;
  headline?: string;
  summary?: string;
  nextSteps?: unknown;
  narrativeSource?: string;
  tasks?: unknown;
  /** Every action sent this run, preparation included, not only the tasks. */
  actions?: unknown;
  ownerQuestions?: unknown;
  executionState?: string | null;
  paidCalls?: number;
  discountedCalls?: number;
  blockingReason?: string | null;
  spend?: unknown;
  completion?: unknown;
}

// A malformed entry would break the owner's whole run history when rendered.
function wellFormed<T>(value: unknown, schema: z.ZodType<T>, max: number): T[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function clamp(value: unknown, max: number, fallback: string): string {
  const text =
    typeof value === "string" && value.trim() ? value.trim() : fallback;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Record what the agent told its owner.
 *
 * Deliberately permissive about content and strict about size: a report that
 * cannot be stored is a run the owner never hears about, which is worse than a
 * truncated one.
 */
export async function recordAgentRunReport(
  principal: QuestPrincipal,
  input: AgentRunReportInput,
): Promise<ServiceResult> {
  if (principal.actorKind !== "agent" || !principal.agentId) {
    return fail(403, "AGENT_ONLY", "Only an agent can publish a run report");
  }

  const supabase = createAgentAdminClient();

  const nextSteps = Array.isArray(input.nextSteps)
    ? input.nextSteps.slice(0, MAX_STEPS).map((s) => String(s).slice(0, 500))
    : [];
  const tasks = wellFormed(input.tasks, reportTaskSchema, MAX_TASKS);
  const actions = wellFormed(input.actions, reportActionSchema, MAX_ACTIONS);
  const ownerQuestions = Array.isArray(input.ownerQuestions)
    ? input.ownerQuestions.slice(0, MAX_OWNER_QUESTIONS).flatMap((question) => {
        const parsed = ownerQuestionSchema.safeParse(question);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const parsedSpend = runSpendSchema.safeParse(input.spend);
  const parsedCompletion = questCompletionSchema.safeParse(input.completion);

  const { data, error } = await supabase
    .from("agent_run_reports")
    .insert({
      agent_id: principal.agentId,
      owner_user_id: principal.userId,
      daily_quest_run_id: input.dailyQuestRunId ?? null,
      succeeded: input.succeeded === true,
      quest_completed: input.questCompleted === true,
      headline: clamp(input.headline, MAX_HEADLINE, "Agent run finished"),
      summary: clamp(input.summary, MAX_SUMMARY, "No details were reported."),
      next_steps: nextSteps,
      narrative_source:
        input.narrativeSource === "llm" ? "llm" : "deterministic",
      tasks: tasks as Json,
      actions: actions as Json,
      owner_questions: ownerQuestions,
      execution_state: input.executionState
        ? String(input.executionState).slice(0, 40)
        : null,
      paid_calls: Number.isFinite(input.paidCalls)
        ? Number(input.paidCalls)
        : 0,
      discounted_calls: Number.isFinite(input.discountedCalls)
        ? Number(input.discountedCalls)
        : 0,
      blocking_reason: input.blockingReason
        ? String(input.blockingReason).slice(0, 2000)
        : null,
      spend: (parsedSpend.success ? parsedSpend.data : {}) as Json,
      completion: parsedCompletion.success ? parsedCompletion.data : null,
    })
    .select("id,created_at")
    .maybeSingle();

  if (error) {
    log.error("Failed to record agent run report", {
      agentId: principal.agentId,
      error,
    });
    return fail(500, "REPORT_SAVE_FAILED", "Failed to record the run report");
  }

  return ok({
    reportId: data?.id ?? null,
    createdAt: data?.created_at ?? null,
  });
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Number.isInteger(value)
    ? Math.min(Math.max(value as number, min), max)
    : fallback;
}

export async function listAgentRunReports(
  ownerUserId: string,
  options: { limit?: number; offset?: number; agentId?: string } = {},
): Promise<ServiceResult> {
  const limit = boundedInteger(options.limit, 20, 1, 50);
  const offset = boundedInteger(options.offset, 0, 0, 10_000);
  const supabase = createAgentAdminClient();
  let query = supabase
    .from("agent_run_reports")
    .select(REPORT_COLUMNS, { count: "exact" })
    .eq("owner_user_id", ownerUserId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (options.agentId) query = query.eq("agent_id", options.agentId);
  const { data, error, count } = await query;

  if (error) {
    log.error("Failed to list agent run reports", { ownerUserId, error });
    return fail(500, "REPORTS_FETCH_FAILED", "Failed to load run reports");
  }

  const reports = ((data ?? []) as any[]).map(({ quest, ...report }) => ({
    ...report,
    quest_title: quest?.template?.title ?? null,
  }));

  return ok({ reports, total: count ?? reports.length, limit, offset });
}
