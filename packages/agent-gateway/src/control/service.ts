import { base } from "viem/chains";
import { decisionFrameV1Schema } from "@p2e/agent-contracts";
import { createPublicClientForNetwork } from "@/lib/blockchain/config/clients/public-client";
import { hasActiveChatMembership } from "@/lib/chat/server/respond-membership";
import { describeQuestAvailability } from "@/lib/agent-chat/server/executable-quests";
import { inngest } from "@/lib/inngest/client";
import { listDailyQuests } from "@/lib/quests/daily-quests/services/read";
import { createHeadlessAgentAdminClient } from "@/lib/supabase/headless-agent-schema";
import {
  assessAdmission,
  blockedAdmission,
} from "@/packages/agent-runner/src/admission";
import { loadPlatformConfig } from "@/packages/agent-runner/src/config";
import type { HeadlessAuthorization } from "../auth/headless-authorization";
import type { RegisteredAgent } from "../db/agents";

export type HeadlessControlContext = {
  authorization: HeadlessAuthorization;
  agent: RegisteredAgent;
  clientId: string;
  scopes: string[];
};

function principal(ctx: HeadlessControlContext) {
  if (!ctx.agent.agentWallet) throw new Error("AGENT_NOT_READY");
  return {
    userId: ctx.agent.ownerUserId,
    agentId: ctx.agent.id,
    executionWallet: ctx.agent.agentWallet,
    rewardWallet: ctx.agent.rewardWallet,
    actorKind: "agent" as const,
  };
}

async function requirePaidAccess(ctx: HeadlessControlContext) {
  if (!(await hasActiveChatMembership(ctx.agent.ownerUserId))) {
    throw new Error("PAID_ACCESS_REQUIRED");
  }
}

export async function getHeadlessConfig(ctx: HeadlessControlContext) {
  return {
    agent: {
      id: ctx.agent.id,
      wallet: ctx.agent.agentWallet,
      rewardWallet: ctx.agent.rewardWallet,
      status: ctx.agent.status,
    },
    authorization: {
      id: ctx.authorization.id,
      policy: ctx.authorization.policy,
      policyHash: ctx.authorization.policyHash,
      expiresAt: ctx.authorization.expiresAt,
    },
  };
}

export async function listHeadlessQuests(ctx: HeadlessControlContext) {
  const result = await listDailyQuests(
    principal(ctx),
    ctx.authorization.policy.templateIds,
  );
  if (result.status >= 400) throw new Error("QUEST_LIST_UNAVAILABLE");
  return result.body;
}

export async function assessHeadlessQuest(
  ctx: HeadlessControlContext,
  runId: string,
) {
  const actor = principal(ctx);
  const availability = await describeQuestAvailability(actor);
  const run = availability.executable.find((candidate) => candidate.id === runId);
  if (!run) {
    const reason =
      availability.blocked.find((candidate) => candidate.runId === runId) ??
      availability.blocked[0];
    return {
      assessment: blockedAdmission(actor.executionWallet, {
        code: reason?.code ?? "QUEST_UNAVAILABLE",
        message: reason?.message ?? "This quest is not available to the agent.",
        ...(reason?.taskId ? { taskId: reason.taskId } : {}),
      }),
    };
  }
  const config = loadPlatformConfig({
    providerAccountName: ctx.agent.providerAccountName ?? `read-${ctx.agent.id}`,
    maxFundingSwaps: ctx.authorization.policy.maxFundingSwapsPerRun,
  });
  return {
    assessment: await assessAdmission(
      {
        address: actor.executionWallet as `0x${string}`,
        caip2: `eip155:${base.id}`,
        publicClient: createPublicClientForNetwork({ chainId: base.id }),
      },
      config,
      run,
    ),
  };
}

export async function startHeadlessRun(
  ctx: HeadlessControlContext,
  input: { runId: string; requestId: string; maxFeeRaw: string },
) {
  await requirePaidAccess(ctx);
  if (BigInt(input.maxFeeRaw) > BigInt(ctx.authorization.policy.maxX402PerRunRaw)) {
    throw new Error("POLICY_DENIED");
  }
  const db = createHeadlessAgentAdminClient();
  const { data, error } = await db.rpc("create_headless_agent_command", {
    p_agent_id: ctx.agent.id,
    p_authorization_id: ctx.authorization.id,
    p_owner_user_id: ctx.agent.ownerUserId,
    p_client_request_id: input.requestId,
    p_run_id: input.runId,
    p_max_x402_fee_raw: input.maxFeeRaw,
  });
  if (error) throw error;
  const result = data as Record<string, unknown>;
  if (result.outcome !== "queued") throw new Error(String(result.outcome));
  const commandId = String(result.command_id);
  if (result.replayed !== true) {
    await inngest.send({
      id: `headless-agent-execution-${commandId}`,
      name: "agent/execution.requested",
      data: { agentId: ctx.agent.id, commandId },
    });
  }
  return {
    commandId,
    status: result.status,
    stateVersion: result.state_version,
    replayed: result.replayed === true,
  };
}

export async function getHeadlessRun(
  ctx: HeadlessControlContext,
  commandId: string,
) {
  const db = createHeadlessAgentAdminClient();
  const { data: command, error } = await db
    .from("agent_commands")
    .select("*")
    .eq("id", commandId)
    .eq("agent_id", ctx.agent.id)
    .eq("owner_user_id", ctx.agent.ownerUserId)
    .eq("controller", "headless")
    .maybeSingle();
  if (error) throw error;
  if (!command) throw new Error("RUN_NOT_FOUND");
  let execution = null;
  if (command.execution_id) {
    const loaded = await db
      .from("agent_run_executions")
      .select("*")
      .eq("id", command.execution_id)
      .eq("agent_id", ctx.agent.id)
      .maybeSingle();
    if (loaded.error) throw loaded.error;
    execution = loaded.data;
  }
  const commandDecision = command.pending_decision as Record<
    string,
    unknown
  > | null;
  const executionDecision = execution?.pending_decision as Record<
    string,
    unknown
  > | null;
  let decision: Record<string, unknown> | null = null;
  if (commandDecision?.kind === "admission") {
    const options = Array.isArray(commandDecision.options)
      ? commandDecision.options.filter(
          (option): option is "proceed" | "retry" | "cancel" =>
            option === "proceed" || option === "retry" || option === "cancel",
        )
      : [];
    decision = {
      kind: "admission",
      commandId: command.id,
      expectedCommandVersion: command.state_version,
      assessment: commandDecision.assessment ?? null,
      options,
    };
  } else if (executionDecision?.kind === "action_selection") {
    const parsed = decisionFrameV1Schema.safeParse({
      version: executionDecision.version,
      frameId: executionDecision.frameId,
      commandId: executionDecision.commandId,
      executionId: executionDecision.executionId,
      expectedExecutionVersion: executionDecision.expectedExecutionVersion,
      candidates: executionDecision.candidates,
      expiresAt: executionDecision.expiresAt,
    });
    decision = parsed.success
      ? { kind: "action_selection", ...parsed.data }
      : null;
  } else if (typeof executionDecision?.id === "string") {
    const options = Array.isArray(executionDecision.options)
      ? executionDecision.options.filter(
          (option): option is "retry" | "finalize" | "cancel" =>
            option === "retry" || option === "finalize" || option === "cancel",
        )
      : [];
    decision = {
      kind: "run_resolution",
      commandId: command.id,
      executionId: execution?.id,
      decisionId: executionDecision.id,
      expectedExecutionVersion: execution?.state_version,
      expectedCommandVersion: command.state_version,
      code: executionDecision.code ?? null,
      question: executionDecision.question ?? null,
      options,
    };
  }
  return {
    command: {
      id: command.id,
      runId: command.requested_run_id,
      status: command.status,
      stateVersion: command.state_version,
      errorCode: command.last_error_code,
      createdAt: command.created_at,
      updatedAt: command.updated_at,
    },
    execution: execution
      ? {
          id: execution.id,
          status: execution.status,
          stateVersion: execution.state_version,
          decisionDeadline: execution.decision_deadline,
          error: execution.last_error,
          updatedAt: execution.updated_at,
        }
      : null,
    decision,
  };
}

export async function chooseHeadlessCandidate(
  ctx: HeadlessControlContext,
  input: {
    commandId: string;
    frameId: string;
    candidateId: string;
    expectedExecutionVersion: number;
  },
) {
  await requirePaidAccess(ctx);
  const db = createHeadlessAgentAdminClient();
  const { data, error } = await db.rpc("resolve_headless_agent_candidate", {
    p_agent_id: ctx.agent.id,
    p_authorization_id: ctx.authorization.id,
    p_command_id: input.commandId,
    p_frame_id: input.frameId,
    p_candidate_id: input.candidateId,
    p_expected_execution_version: input.expectedExecutionVersion,
  });
  if (error) throw error;
  const result = data as Record<string, unknown>;
  if (result.outcome !== "resolved") throw new Error("DECISION_STALE");
  await inngest.send({
    id: `headless-agent-decision-${input.commandId}-${result.execution_state_version}`,
    name: "agent/execution.continue",
    data: {
      agentId: ctx.agent.id,
      executionId: result.execution_id,
      expectedVersion: result.execution_state_version,
    },
  });
  return result;
}

export async function resolveHeadlessAdmission(
  ctx: HeadlessControlContext,
  input: {
    commandId: string;
    expectedCommandVersion: number;
    resolution: "proceed" | "retry" | "cancel";
  },
) {
  await requirePaidAccess(ctx);
  const db = createHeadlessAgentAdminClient();
  const { data, error } = await db.rpc(
    "resolve_headless_agent_admission_decision",
    {
      p_agent_id: ctx.agent.id,
      p_authorization_id: ctx.authorization.id,
      p_command_id: input.commandId,
      p_expected_version: input.expectedCommandVersion,
      p_resolution: input.resolution,
    },
  );
  if (error) throw error;
  const result = data as Record<string, unknown>;
  if (result.outcome !== "resolved") throw new Error("DECISION_STALE");
  if (input.resolution !== "cancel" && result.replayed !== true) {
    await inngest.send({
      id: `headless-agent-admission-${input.commandId}-${result.command_state_version}`,
      name: "agent/execution.requested",
      data: { agentId: ctx.agent.id, commandId: input.commandId },
    });
  }
  return result;
}

export async function resolveHeadlessRunDecision(
  ctx: HeadlessControlContext,
  input: {
    commandId: string;
    decisionId: string;
    expectedExecutionVersion: number;
    expectedCommandVersion: number;
    resolution: "retry" | "finalize" | "cancel";
  },
) {
  await requirePaidAccess(ctx);
  const db = createHeadlessAgentAdminClient();
  const { data, error } = await db.rpc("resolve_headless_agent_run_decision", {
    p_agent_id: ctx.agent.id,
    p_authorization_id: ctx.authorization.id,
    p_command_id: input.commandId,
    p_decision_id: input.decisionId,
    p_expected_execution_version: input.expectedExecutionVersion,
    p_expected_command_version: input.expectedCommandVersion,
    p_resolution: input.resolution,
  });
  if (error) throw error;
  const result = data as Record<string, unknown>;
  if (result.outcome !== "resolved") throw new Error("DECISION_STALE");
  if (input.resolution !== "cancel") {
    await inngest.send({
      id: `headless-agent-resolution-${input.commandId}-${result.execution_state_version}`,
      name: "agent/execution.continue",
      data: {
        agentId: ctx.agent.id,
        executionId: result.execution_id,
        expectedVersion: result.execution_state_version,
      },
    });
  }
  return result;
}

export async function cancelHeadlessRun(
  ctx: HeadlessControlContext,
  input: { commandId: string; expectedVersion: number },
) {
  const db = createHeadlessAgentAdminClient();
  const { data, error } = await db.rpc("cancel_headless_agent_command", {
    p_agent_id: ctx.agent.id,
    p_authorization_id: ctx.authorization.id,
    p_command_id: input.commandId,
    p_expected_version: input.expectedVersion,
  });
  if (error) throw error;
  const result = data as Record<string, unknown>;
  if (result.outcome !== "cancelled") throw new Error("RUN_CONFLICT");
  return result;
}

export async function getHeadlessUsage(ctx: HeadlessControlContext) {
  const db = createHeadlessAgentAdminClient();
  const windowStartedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: lines, error } = await db
    .from("agent_effect_usage_lines")
    .select("*")
    .eq("agent_id", ctx.agent.id)
    .gte("created_at", windowStartedAt)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  const effectIds = [...new Set((lines ?? []).map((line) => line.effect_id))];
  const effectsResult = effectIds.length
    ? await db
        .from("agent_effect_reservations")
        .select("*")
        .eq("agent_id", ctx.agent.id)
        .in("id", effectIds)
    : { data: [], error: null };
  if (effectsResult.error) throw effectsResult.error;
  const effects = new Map(
    (effectsResult.data ?? []).map((effect) => [effect.id, effect]),
  );
  const totals = new Map<string, { category: string; asset: string; reservedRaw: bigint; actualRaw: bigint }>();
  for (const line of lines ?? []) {
    const effect = effects.get(line.effect_id);
    if (!effect || effect.state === "released") continue;
    const key = `${line.category}:${line.asset}:${line.token_address ?? "native"}`;
    const current = totals.get(key) ?? {
      category: line.category,
      asset: line.asset,
      reservedRaw: 0n,
      actualRaw: 0n,
    };
    current.reservedRaw += BigInt(line.reserved_raw);
    current.actualRaw += BigInt(line.actual_raw ?? line.reserved_raw);
    totals.set(key, current);
  }
  return {
    agentId: ctx.agent.id,
    windowStartedAt,
    totals: [...totals.values()].map((total) => ({
      ...total,
      reservedRaw: total.reservedRaw.toString(),
      actualRaw: total.actualRaw.toString(),
    })),
    lines: (lines ?? []).flatMap((line) => {
      const effect = effects.get(line.effect_id);
      if (!effect) return [];
      return [
        {
          effectId: effect.id,
          commandId: line.command_id,
          executionId: effect.execution_id,
          actionId: effect.action_id,
          category: line.category,
          asset: line.asset,
          tokenAddress: line.token_address,
          reservedRaw: String(line.reserved_raw),
          actualRaw:
            line.actual_raw === null ? null : String(line.actual_raw),
          state: effect.state,
          createdAt: line.created_at,
        },
      ];
    }),
  };
}
