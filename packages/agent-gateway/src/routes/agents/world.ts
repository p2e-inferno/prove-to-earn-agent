import { NextResponse, type NextRequest } from "next/server";
import { isAddress, type Address } from "viem";
import { z } from "zod";
import {
  AGENTBOOK_ACTION,
  AGENTBOOK_APP_ID,
  agentBookSignal,
  lookupAgentBookHuman,
  nextAgentBookNonce,
  normalizeAgentBookProof,
  submitAgentBookRegistration,
} from "@vendor/agent-world/registration";
import { callWithAgentLifecycleVersion } from "@vendor/agent-world/lifecycle";
import { inngest } from "@vendor/inngest-client";
import { createAgentAdminClient } from "@adapters/datastore";
import { getLogger } from "@vendor/logger";
import { rateLimiter } from "@vendor/agent-rate-limiter";
import { findOwnedAgent } from "../../db/agents";
import { agentError, agentOk } from "../../errors";
import { createPairingRoute } from "../../route-factory";

const log = getLogger("agent-gateway:routes:agents:world");
const SESSION_TTL_MS = 5 * 60 * 1000;
const WORLD_ATTEMPTS_PER_HOUR = 6;

// Separate counters: a completion carries a proof World has already consumed,
// so refusing it because session starts used the budget would waste that proof.
async function worldAttemptAllowed(
  ownerUserId: string,
  agentId: string,
  phase: "session" | "complete" | "reconcile",
) {
  const limits = await Promise.all([
    rateLimiter.check(
      `agent-world-${phase}:${ownerUserId}`,
      WORLD_ATTEMPTS_PER_HOUR,
      60 * 60 * 1000,
    ),
    rateLimiter.check(
      `agent-world-${phase}:${ownerUserId}:${agentId}`,
      WORLD_ATTEMPTS_PER_HOUR,
      60 * 60 * 1000,
    ),
  ]);
  if (limits.some((limit) => limit.unavailable))
    throw new Error("World rate limiting service unavailable");
  return limits.find((limit) => !limit.success) ?? limits[0]!;
}

const completionSchema = z
  .object({
    attemptId: z.string().uuid(),
    root: z
      .string()
      .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/)
      .max(256),
    nullifierHash: z
      .string()
      .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/)
      .max(256),
    proof: z.string().min(1).max(8192),
  })
  .strict();

async function setWorldState(input: {
  agentId: string;
  ownerUserId: string;
  stateVersion: number;
  worldStatus: string;
  humanId?: string | null;
  transactionHash?: string | null;
  errorCode?: string | null;
}): Promise<Record<string, unknown>> {
  return callWithAgentLifecycleVersion({
    agentId: input.agentId,
    ownerUserId: input.ownerUserId,
    expectedVersion: input.stateVersion,
    call: (expectedVersion) =>
      createAgentAdminClient().rpc("set_platform_agent_world_state", {
        p_agent_id: input.agentId,
        p_owner_user_id: input.ownerUserId,
        p_world_status: input.worldStatus,
        p_agentbook_human_id: input.humanId ?? null,
        p_transaction_hash: input.transactionHash ?? null,
        p_error_code: input.errorCode ?? null,
        p_expected_version: expectedVersion,
      }),
  });
}

export const SESSION = createPairingRoute({
  guard: "owner-privy-session",
  handler: async (
    _req: NextRequest,
    params,
    ownerUserId: string | null,
  ): Promise<NextResponse> => {
    if (!ownerUserId) {
      return agentError(
        401,
        "OWNER_AUTH_REQUIRED",
        "Owner authentication is required",
      );
    }
    if (!params.agentId) {
      return agentError(400, "INVALID_REQUEST", "Missing agentId");
    }
    if (
      !(await worldAttemptAllowed(ownerUserId, params.agentId, "session"))
        .success
    ) {
      return agentError(
        429,
        "WORLD_RATE_LIMITED",
        "Try World verification again later",
      );
    }

    const agent = await findOwnedAgent(params.agentId, ownerUserId);
    if (!agent) {
      return agentError(
        404,
        "AGENT_UNKNOWN",
        "Agent not found for this account",
      );
    }
    if (agent.status !== "ready" || !agent.agentWallet) {
      return agentError(
        409,
        "AGENT_NOT_READY",
        "The agent wallet is not ready",
      );
    }
    if (!isAddress(agent.agentWallet)) {
      return agentError(500, "AGENT_WALLET_INVALID", "Agent wallet is invalid");
    }

    let humanId: string | null;
    try {
      humanId = await lookupAgentBookHuman(agent.agentWallet as Address);
    } catch {
      await setWorldState({
        agentId: agent.id,
        ownerUserId,
        stateVersion: agent.lifecycleVersion,
        worldStatus: "failed",
        errorCode: "WORLD_LOOKUP_UNAVAILABLE",
      }).catch(() => null);
      return agentError(
        503,
        "WORLD_LOOKUP_UNAVAILABLE",
        "World verification is temporarily unavailable; your agent remains usable",
      );
    }
    if (humanId) {
      const result = await setWorldState({
        agentId: agent.id,
        ownerUserId,
        stateVersion: agent.lifecycleVersion,
        worldStatus: "verified",
        humanId,
      });
      if (result.success !== true) {
        return agentError(
          409,
          "WORLD_STATE_CONFLICT",
          "World state changed; retry",
        );
      }
      return agentOk({ alreadyVerified: true, worldStatus: "verified" });
    }

    let nonce: bigint;
    try {
      nonce = await nextAgentBookNonce(agent.agentWallet as Address);
    } catch {
      await setWorldState({
        agentId: agent.id,
        ownerUserId,
        stateVersion: agent.lifecycleVersion,
        worldStatus: "failed",
        errorCode: "WORLD_RPC_UNAVAILABLE",
      }).catch(() => null);
      return agentError(
        503,
        "WORLD_RPC_UNAVAILABLE",
        "World verification is temporarily unavailable; your agent remains usable",
      );
    }
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const { data, error } = await createAgentAdminClient().rpc(
      "start_agent_world_registration",
      {
        p_agent_id: agent.id,
        p_owner_user_id: ownerUserId,
        p_nonce: nonce.toString(),
        p_expires_at: expiresAt,
        p_expected_version: agent.lifecycleVersion,
      },
    );
    if (error) throw error;
    const state = (data ?? {}) as Record<string, unknown>;
    if (state.success !== true) {
      return agentError(
        409,
        String(state.error ?? "WORLD_STATE_CONFLICT"),
        "World verification state changed; retry",
      );
    }
    const attemptId = String(state.registration_id ?? "");
    if (!z.string().uuid().safeParse(attemptId).success) {
      throw new Error("World attempt was not created");
    }

    return agentOk({
      alreadyVerified: false,
      attemptId,
      appId: AGENTBOOK_APP_ID,
      action: AGENTBOOK_ACTION,
      signal: agentBookSignal(agent.agentWallet as Address, nonce),
      expiresAt,
    });
  },
});

export const SKIP = createPairingRoute({
  guard: "owner-privy-session",
  handler: async (
    _req: NextRequest,
    params,
    ownerUserId: string | null,
  ): Promise<NextResponse> => {
    if (!ownerUserId) {
      return agentError(
        401,
        "OWNER_AUTH_REQUIRED",
        "Owner authentication is required",
      );
    }
    if (!params.agentId) {
      return agentError(400, "INVALID_REQUEST", "Missing agentId");
    }
    const agent = await findOwnedAgent(params.agentId, ownerUserId);
    if (!agent) {
      return agentError(
        404,
        "AGENT_UNKNOWN",
        "Agent not found for this account",
      );
    }
    if (agent.worldStatus === "verified") {
      return agentOk({ agentId: agent.id, worldStatus: "verified" });
    }
    const result = await setWorldState({
      agentId: agent.id,
      ownerUserId,
      stateVersion: agent.lifecycleVersion,
      worldStatus: "skipped",
    });
    if (result.success !== true) {
      return agentError(409, "WORLD_STATE_CONFLICT", "World state changed");
    }
    return agentOk({ agentId: agent.id, worldStatus: "skipped" });
  },
});

export const COMPLETE = createPairingRoute({
  guard: "owner-privy-session",
  handler: async (
    req: NextRequest,
    params,
    ownerUserId: string | null,
  ): Promise<NextResponse> => {
    if (!ownerUserId) {
      return agentError(
        401,
        "OWNER_AUTH_REQUIRED",
        "Owner authentication is required",
      );
    }
    if (!params.agentId) {
      return agentError(400, "INVALID_REQUEST", "Missing agentId");
    }
    if (
      !(await worldAttemptAllowed(ownerUserId, params.agentId, "complete"))
        .success
    ) {
      return agentError(
        429,
        "WORLD_RATE_LIMITED",
        "Try World verification again later",
      );
    }
    const parsed = completionSchema.safeParse(
      await req.json().catch(() => null),
    );
    if (!parsed.success) {
      return agentError(400, "INVALID_REQUEST", "Invalid World proof result");
    }

    const agent = await findOwnedAgent(params.agentId, ownerUserId);
    if (!agent || !agent.agentWallet || !isAddress(agent.agentWallet)) {
      return agentError(
        404,
        "AGENT_UNKNOWN",
        "Agent not found for this account",
      );
    }
    if (agent.status !== "ready") {
      return agentError(409, "AGENT_NOT_READY", "The agent is not ready");
    }

    const supabase = createAgentAdminClient();
    const { data: attempt, error: attemptError } = await supabase
      .from("agent_world_registrations")
      .select("id, nonce, status, expires_at, relay_transaction_hash")
      .eq("id", parsed.data.attemptId)
      .eq("agent_id", agent.id)
      .maybeSingle();
    if (attemptError) throw attemptError;
    if (attempt?.status === "submitted" || attempt?.status === "relaying") {
      await inngest.send({
        id: `agent-world-${attempt.id}`,
        name: "agent/world-registration.reconcile",
        data: { agentId: agent.id, registrationId: attempt.id },
      });
      return agentOk(
        {
          agentId: agent.id,
          worldStatus:
            attempt.status === "submitted" ? "submitted" : "in_progress",
          transactionHash: attempt.relay_transaction_hash,
        },
        202,
      );
    }
    if (
      !attempt ||
      attempt.status !== "in_progress" ||
      new Date(attempt.expires_at).getTime() <= Date.now()
    ) {
      return agentError(
        409,
        "WORLD_ATTEMPT_EXPIRED",
        "World verification expired; start again",
      );
    }

    let nonce: bigint;
    try {
      nonce = await nextAgentBookNonce(agent.agentWallet as Address);
    } catch {
      await supabase.rpc("fail_agent_world_registration", {
        p_registration_id: attempt.id,
        p_agent_id: agent.id,
        p_owner_user_id: ownerUserId,
        p_error_code: "WORLD_RPC_UNAVAILABLE",
        p_expected_version: agent.lifecycleVersion,
      });
      return agentError(
        503,
        "WORLD_RPC_UNAVAILABLE",
        "World verification is temporarily unavailable; your agent remains usable",
      );
    }
    if (nonce.toString() !== attempt.nonce) {
      return agentError(
        409,
        "WORLD_NONCE_CHANGED",
        "World registration changed; start again",
      );
    }
    const proof = normalizeAgentBookProof(parsed.data.proof);
    if (!proof) {
      return agentError(400, "WORLD_PROOF_INVALID", "World proof is malformed");
    }

    const { data: claimData, error: claimError } = await supabase.rpc(
      "claim_agent_world_registration_submission",
      {
        p_registration_id: attempt.id,
        p_agent_id: agent.id,
        p_owner_user_id: ownerUserId,
        p_expected_version: agent.lifecycleVersion,
      },
    );
    if (claimError) throw claimError;
    const claim = (claimData ?? {}) as Record<string, unknown>;
    if (claim.success !== true) {
      return agentError(
        409,
        String(claim.error ?? "WORLD_STATE_CONFLICT"),
        "World verification state changed; start again",
      );
    }

    let relayAccepted = false;
    let relayTransactionHash: string | null = null;
    try {
      const registration = await submitAgentBookRegistration({
        agent: agent.agentWallet as Address,
        root: parsed.data.root,
        nonce: attempt.nonce,
        nullifierHash: parsed.data.nullifierHash,
        proof,
      });
      relayAccepted = true;
      relayTransactionHash = registration.txHash;
      const state = await callWithAgentLifecycleVersion({
        agentId: agent.id,
        ownerUserId,
        expectedVersion: agent.lifecycleVersion,
        call: (expectedVersion) =>
          supabase.rpc("submit_agent_world_registration", {
            p_registration_id: attempt.id,
            p_agent_id: agent.id,
            p_owner_user_id: ownerUserId,
            p_transaction_hash: registration.txHash,
            p_expected_version: expectedVersion,
          }),
      });
      if (state.success !== true) {
        throw new Error(String(state.error ?? "World state update failed"));
      }

      await inngest.send({
        id: `agent-world-${attempt.id}`,
        name: "agent/world-registration.reconcile",
        data: { agentId: agent.id, registrationId: attempt.id },
      });
      return agentOk(
        {
          agentId: agent.id,
          worldStatus: "submitted",
          transactionHash: registration.txHash,
        },
        202,
      );
    } catch (error) {
      log.warn("AgentBook registration submission failed", {
        agentId: agent.id,
        error,
      });
      if (relayAccepted) {
        await setWorldState({
          agentId: agent.id,
          ownerUserId,
          stateVersion: agent.lifecycleVersion,
          worldStatus: "submitted",
          transactionHash: relayTransactionHash,
        }).catch(() => null);
        try {
          await inngest.send({
            id: `agent-world-${attempt.id}`,
            name: "agent/world-registration.reconcile",
            data: { agentId: agent.id, registrationId: attempt.id },
          });
        } catch {
          return agentError(
            503,
            "WORLD_RECONCILIATION_QUEUE_UNAVAILABLE",
            "World received the proof, but confirmation could not be queued; retry this step",
          );
        }
        return agentOk(
          {
            agentId: agent.id,
            worldStatus: "submitted",
            transactionHash: relayTransactionHash,
          },
          202,
        );
      }
      try {
        const { error: stateError } = await supabase.rpc(
          "fail_agent_world_registration",
          {
            p_registration_id: attempt.id,
            p_agent_id: agent.id,
            p_owner_user_id: ownerUserId,
            p_error_code: "WORLD_RELAY_FAILED",
            p_expected_version: agent.lifecycleVersion,
          },
        );
        if (stateError) throw stateError;
      } catch {
        log.warn("World registration failure state was not persisted", {
          agentId: agent.id,
          registrationId: attempt.id,
        });
      }
      return agentError(
        503,
        "WORLD_RELAY_FAILED",
        "World registration could not be submitted; try again",
      );
    }
  },
});

export const RECONCILE = createPairingRoute({
  guard: "owner-privy-session",
  handler: async (_req, params, ownerUserId) => {
    if (!ownerUserId)
      return agentError(401, "OWNER_AUTH_REQUIRED", "Sign in first");
    const agent = await findOwnedAgent(params.agentId ?? "", ownerUserId);
    if (!agent || agent.status !== "ready")
      return agentError(404, "AGENT_UNKNOWN", "Agent unavailable");
    const limit = await worldAttemptAllowed(ownerUserId, agent.id, "reconcile");
    if (!limit.success)
      return agentError(429, "RATE_LIMITED", "Try again later");
    const { data: attempt, error } = await createAgentAdminClient()
      .from("agent_world_registrations")
      .select("id")
      .eq("agent_id", agent.id)
      .in("status", ["relaying", "submitted"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error)
      return agentError(
        503,
        "WORLD_UNAVAILABLE",
        "Could not read registration",
      );
    if (!attempt)
      return agentError(
        409,
        "WORLD_ATTEMPT_UNKNOWN",
        "No pending registration",
      );
    await inngest.send({
      name: "agent/world-registration.reconcile",
      data: { agentId: agent.id, registrationId: attempt.id },
    });
    return agentOk({ worldStatus: "submitted" }, 202);
  },
});
