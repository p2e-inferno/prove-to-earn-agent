import { z } from "zod";
import { createAgentAdminClient } from "@adapters/datastore";
import {
  fail,
  ok,
  type QuestPrincipal,
  type ServiceResult,
} from "@vendor/quests/principal";

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

const checkpointInputSchema = z
  .object({
    operation: z.literal("checkpoint"),
    executionId: z.string().uuid(),
    attemptToken: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    status: executionStatusSchema,
    checkpoint: z.record(z.unknown()),
    nextRetryAt: z.string().datetime().nullable().optional(),
    pendingDecision: z.record(z.unknown()).nullable().optional(),
    decisionDeadline: z.string().datetime().nullable().optional(),
    lastError: z.record(z.unknown()).nullable().optional(),
    releaseLease: z.boolean().optional(),
  })
  .strict();

const acquireInputSchema = z
  .object({ operation: z.literal("acquire") })
  .strict();

const renewInputSchema = z
  .object({
    operation: z.literal("renew"),
    executionId: z.string().uuid(),
    attemptToken: z.string().uuid(),
  })
  .strict();

export const executionMutationSchema = z.discriminatedUnion("operation", [
  acquireInputSchema,
  renewInputSchema,
  checkpointInputSchema,
]);

export async function mutateAgentRunExecution(
  principal: QuestPrincipal,
  runId: string,
  rawInput: unknown,
): Promise<ServiceResult> {
  if (principal.actorKind !== "agent" || !principal.agentId) {
    return fail(403, "AGENT_ONLY", "Only an agent can manage an execution");
  }
  const parsed = executionMutationSchema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(400, "INVALID_REQUEST", "Invalid execution request");
  }

  const supabase = createAgentAdminClient();
  if (parsed.data.operation === "acquire") {
    const { data, error } = await supabase.rpc("acquire_agent_run_execution", {
      p_agent_id: principal.agentId,
      p_owner_user_id: principal.userId,
      p_run_id: runId,
      p_lease_seconds: 120,
    });
    if (error) return fail(503, "EXECUTION_UNAVAILABLE", error.message);
    const result = (data ?? {}) as Record<string, unknown>;
    if (result.outcome === "busy") {
      return fail(409, "EXECUTION_BUSY", "Another worker holds this run");
    }
    if (result.outcome === "forbidden") {
      return fail(
        403,
        "EXECUTION_FORBIDDEN",
        "This execution has another owner",
      );
    }
    return ok({ execution: result });
  }

  // A heartbeat carries no state, so it never competes with a checkpoint for
  // the execution's version.
  if (parsed.data.operation === "renew") {
    const { data, error } = await supabase.rpc("renew_agent_run_lease", {
      p_execution_id: parsed.data.executionId,
      p_attempt_token: parsed.data.attemptToken,
      p_lease_seconds: 120,
    });
    if (error) return fail(503, "EXECUTION_UNAVAILABLE", error.message);
    const result = (data ?? {}) as Record<string, unknown>;
    if (result.outcome !== "renewed") {
      return fail(409, "EXECUTION_LEASE_LOST", "This lease is no longer held");
    }
    return ok({ execution: result });
  }

  const input = parsed.data;
  const { data, error } = await supabase.rpc("checkpoint_agent_run_execution", {
    p_execution_id: input.executionId,
    p_attempt_token: input.attemptToken,
    p_expected_version: input.expectedVersion,
    p_status: input.status,
    p_checkpoint: input.checkpoint as never,
    p_next_retry_at: input.nextRetryAt ?? null,
    p_pending_decision: (input.pendingDecision ?? null) as never,
    p_decision_deadline: input.decisionDeadline ?? null,
    p_last_error: (input.lastError ?? null) as never,
    p_lease_seconds: 120,
    p_release_lease: input.releaseLease ?? false,
  });
  if (error) return fail(503, "CHECKPOINT_UNAVAILABLE", error.message);
  const result = (data ?? {}) as Record<string, unknown>;
  if (result.outcome !== "saved") {
    return fail(
      409,
      "EXECUTION_LEASE_LOST",
      "Execution state changed; reload it",
    );
  }
  return ok({ execution: result });
}

export async function listOwnerAgentExecutions(
  ownerUserId: string,
  agentId: string,
): Promise<ServiceResult> {
  const supabase = createAgentAdminClient();
  const { data: agent } = await supabase
    .from("registered_agents")
    .select("id")
    .eq("id", agentId)
    .eq("owner_user_id", ownerUserId)
    .maybeSingle();
  if (!agent) return fail(404, "AGENT_UNKNOWN", "Agent not found");

  const { data, error } = await supabase
    .from("agent_run_executions")
    .select(
      "id,daily_quest_run_id,status,state_version,checkpoint,next_retry_at,pending_decision,decision_deadline,last_error,updated_at",
    )
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .order("updated_at", { ascending: false })
    .limit(20);
  if (error)
    return fail(500, "EXECUTIONS_UNAVAILABLE", "Failed to load executions");
  return ok({ executions: data ?? [] });
}

/** Resolution is bounded to a fixed enum so a model can never widen it. */
const executionResolutionSchema = z
  .object({
    executionId: z.string().uuid(),
    decisionId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    resolution: z.enum(["retry", "finalize", "cancel"]),
  })
  .strict();

const admissionResolutionSchema = z
  .object({
    commandId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    resolution: z.enum(["proceed", "retry", "cancel"]),
  })
  .strict();

const resolutionSchema = z.union([
  executionResolutionSchema,
  admissionResolutionSchema,
]);

export async function resolveOwnerAgentDecision(
  ownerUserId: string,
  agentId: string,
  rawInput: unknown,
): Promise<ServiceResult> {
  const parsed = resolutionSchema.safeParse(rawInput);
  if (!parsed.success) return fail(400, "INVALID_REQUEST", "Invalid decision");
  const supabase = createAgentAdminClient();
  if ("commandId" in parsed.data) {
    const { data, error } = await supabase.rpc(
      "resolve_agent_command_admission_decision",
      {
        p_agent_id: agentId,
        p_owner_user_id: ownerUserId,
        p_command_id: parsed.data.commandId,
        p_expected_version: parsed.data.expectedVersion,
        p_resolution: parsed.data.resolution,
      },
    );
    if (error) {
      return fail(503, "DECISION_UNAVAILABLE", "Could not save the decision");
    }
    const decision = (data ?? {}) as Record<string, unknown>;
    return decision.outcome === "resolved"
      ? ok({ decision })
      : fail(409, "DECISION_CONFLICT", "Decision is stale or already resolved");
  }
  const { data: execution, error: executionError } = await supabase
    .from("agent_run_executions")
    .select("id, command_id")
    .eq("id", parsed.data.executionId)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .maybeSingle();
  if (executionError) {
    return fail(503, "DECISION_UNAVAILABLE", "Could not load the decision");
  }
  if (!execution) return fail(404, "DECISION_UNKNOWN", "Decision not found");
  if (!execution.command_id) {
    const { data, error } = await supabase.rpc("resolve_agent_run_decision", {
      p_execution_id: execution.id,
      p_owner_user_id: ownerUserId,
      p_decision_id: parsed.data.decisionId,
      p_expected_version: parsed.data.expectedVersion,
      p_resolution: parsed.data.resolution,
    });
    if (error)
      return fail(503, "DECISION_UNAVAILABLE", "Could not save the decision");
    const decision = (data ?? {}) as Record<string, unknown>;
    return decision.outcome === "resolved"
      ? ok({ decision })
      : fail(409, "DECISION_CONFLICT", "Decision is stale or already resolved");
  }
  const { data: command, error: commandError } = await supabase
    .from("agent_commands")
    .select("state_version")
    .eq("id", execution.command_id)
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .eq("status", "decision_required")
    .maybeSingle();
  if (commandError) {
    return fail(503, "DECISION_UNAVAILABLE", "Could not load the command");
  }
  if (!command) {
    return fail(409, "DECISION_CONFLICT", "Decision is no longer active");
  }

  const { data, error } = await supabase.rpc(
    "resolve_agent_command_run_decision",
    {
      p_execution_id: parsed.data.executionId,
      p_agent_id: agentId,
      p_owner_user_id: ownerUserId,
      p_decision_id: parsed.data.decisionId,
      p_expected_execution_version: parsed.data.expectedVersion,
      p_expected_command_version: command.state_version,
      p_resolution: parsed.data.resolution,
    },
  );
  if (error) return fail(503, "DECISION_UNAVAILABLE", error.message);
  const result = (data ?? {}) as Record<string, unknown>;
  if (result.outcome !== "resolved") {
    return fail(
      409,
      "DECISION_CONFLICT",
      "Decision is stale or already resolved",
    );
  }
  return ok({ decision: result });
}
