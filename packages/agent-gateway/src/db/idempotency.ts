import { createHash } from "crypto";
import { createAgentAdminClient } from "@/lib/supabase/agent-schema";
import { getLogger } from "@/lib/utils/logger";

const log = getLogger("agent-gateway:db:idempotency");

export type RequestState =
  | "in_flight"
  | "effect_committed"
  | "completed"
  | "failed";

export interface RequestIdentity {
  agentId: string;
  ownerUserId: string;
  idempotencyKey: string;
  method: string;
  /** Canonical route id, e.g. "quests.start". */
  route: string;
  /** Concrete request path, so one key cannot span two runs. */
  pathname: string;
  body: unknown;
}

export type PeekOutcome =
  | { outcome: "absent" }
  | {
      outcome: "found";
      id: string;
      state: RequestState;
      requestHash: string;
      responseStatus: number | null;
      responseBody: unknown;
    };

export type AcquireOutcome =
  | {
      outcome: "acquired";
      id: string;
      attemptToken: string;
      recovered: boolean;
    }
  | { outcome: "conflict"; id: string }
  | { outcome: "in_flight"; id: string }
  | {
      outcome: "replay";
      id: string;
      state: RequestState;
      attemptToken: string | null;
      responseStatus: number | null;
      responseBody: unknown;
    };

/**
 * Identity of the effect, not just of the call.
 *
 * The concrete pathname is part of the hash because the canonical route id is
 * shared across path parameters: without it, one key replayed against a
 * different run id would return the wrong run's response.
 */
export function hashRequest(identity: {
  method: string;
  route: string;
  pathname: string;
  body: unknown;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        method: identity.method,
        route: identity.route,
        pathname: identity.pathname,
        body: identity.body ?? null,
      }),
    )
    .digest("hex");
}

/** Read-only, used before the paywall so a settled call replays without paying. */
export async function peekRequest(
  identity: Pick<
    RequestIdentity,
    "agentId" | "idempotencyKey" | "method" | "route"
  >,
): Promise<PeekOutcome> {
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase.rpc("peek_agent_request", {
    p_agent_id: identity.agentId,
    p_idempotency_key: identity.idempotencyKey,
    p_method: identity.method,
    p_route: identity.route,
  });

  if (error) {
    log.error("peek_agent_request failed", { error });
    throw error;
  }

  const row = (data ?? {}) as Record<string, unknown>;
  if (String(row.outcome) !== "found") return { outcome: "absent" };

  return {
    outcome: "found",
    id: String(row.id),
    state: (row.state as RequestState) ?? "in_flight",
    requestHash: String(row.request_hash ?? ""),
    responseStatus:
      typeof row.response_status === "number" ? row.response_status : null,
    responseBody: row.response_body ?? null,
  };
}

/** Acquire the right to run the effect. Called inside the paywall only. */
export async function acquireRequest(
  identity: RequestIdentity,
  leaseSeconds = 300,
): Promise<AcquireOutcome> {
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase.rpc("acquire_agent_request", {
    p_agent_id: identity.agentId,
    p_owner_user_id: identity.ownerUserId,
    p_idempotency_key: identity.idempotencyKey,
    p_method: identity.method,
    p_route: identity.route,
    p_request_hash: hashRequest(identity),
    p_lease_seconds: leaseSeconds,
  });

  if (error) {
    log.error("acquire_agent_request failed", { error });
    throw error;
  }

  const row = (data ?? {}) as Record<string, unknown>;
  const outcome = String(row.outcome);

  if (outcome === "acquired") {
    const attemptToken = String(row.attempt_token ?? "");
    if (!attemptToken) {
      throw new Error("acquire_agent_request returned no attempt token");
    }
    return {
      outcome: "acquired",
      id: String(row.id),
      attemptToken,
      recovered: row.recovered === true,
    };
  }
  if (outcome === "conflict")
    return { outcome: "conflict", id: String(row.id) };
  if (outcome === "in_flight") {
    return { outcome: "in_flight", id: String(row.id) };
  }

  return {
    outcome: "replay",
    id: String(row.id),
    state: (row.state as RequestState) ?? "in_flight",
    attemptToken:
      typeof row.attempt_token === "string" ? row.attempt_token : null,
    responseStatus:
      typeof row.response_status === "number" ? row.response_status : null,
    responseBody: row.response_body ?? null,
  };
}

/**
 * Partial update: omitted fields keep their stored value.
 *
 * Blanket-nulling cleared the cached response body on the completed
 * transition — the one moment a replay depends on it.
 */
export async function markState(
  requestId: string,
  attemptToken: string,
  state: RequestState,
  patch?: {
    responseStatus?: number;
    responseBody?: unknown;
    paymentId?: string | null;
    payer?: string | null;
    price?: string | null;
    clearLease?: boolean;
  },
): Promise<boolean> {
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase.rpc("update_agent_request_state", {
    p_id: requestId,
    p_attempt_token: attemptToken,
    p_state: state,
    p_response_status: patch?.responseStatus ?? null,
    p_response_body: (patch?.responseBody ?? null) as never,
    p_payment_id: patch?.paymentId ?? null,
    p_payer: patch?.payer ?? null,
    p_price: patch?.price ?? null,
    p_clear_lease: patch?.clearLease ?? false,
  });

  if (error) {
    // Never fatal to the caller: the effect already happened and the response
    // is on its way. A lost marker degrades to a lease-expiry retry, which
    // every quest effect is idempotent against.
    log.error("Failed to update agent request state", {
      requestId,
      state,
      error,
    });
    return false;
  }

  if (data !== true) {
    log.warn("Agent request lease was lost before state update", {
      requestId,
      state,
    });
    return false;
  }

  return true;
}
