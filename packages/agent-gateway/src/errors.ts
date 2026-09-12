import { NextResponse } from "next/server";

export type AgentErrorCode =
  | "AGENT_UNKNOWN"
  | "AGENT_REVOKED"
  | "AGENT_SUSPENDED"
  | "AGENT_CAPABILITY_DENIED"
  | "AGENT_SESSION_INVALID"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_IN_FLIGHT"
  | "OWNER_AUTH_REQUIRED"
  | "GRANT_INVALID"
  | "GRANT_EXPIRED"
  | "NONCE_INVALID"
  | "SIGNATURE_INVALID"
  | "REWARD_WALLET_NOT_OWNED"
  | "AGENT_ALREADY_REGISTERED"
  | "SETTLEMENT_FAILED"
  | "INTERNAL_ERROR";

// Kept in sync with the retryable rate-limit codes in `control/route.ts`'s
// `controlJson` responses — the same code must mean the same retry guidance
// regardless of which envelope builder produced it.
const RETRYABLE = new Set<string>([
  "SETTLEMENT_FAILED",
  "IDEMPOTENCY_IN_FLIGHT",
  "RPC_ERROR",
  "VENDOR_STAGE_UNAVAILABLE",
  "SEAT_UNRESOLVED",
  "XP_AWARD_FAILED",
  "BONUS_AWARD_FAILED",
  "KEY_GRANT_FAILED",
  "RATE_LIMITED",
  "WORLD_RATE_LIMITED",
  "RATE_LIMIT_UNAVAILABLE",
]);

export interface AgentEnvelope<T = unknown> {
  ok: boolean;
  data?: T | null;
  intent?: unknown;
  code?: string;
  message?: string;
  retryable?: boolean;
}

/**
 * Normalise a service result into the agent envelope.
 *
 * The human API returns codes two ways — `{ code }` on some handlers and the
 * code in `{ error }` on others. An agent branches on codes, so both shapes
 * collapse to `code` here rather than being changed upstream.
 */
export function toEnvelope(
  status: number,
  body: unknown,
): { status: number; envelope: AgentEnvelope } {
  if (status >= 200 && status < 300) {
    const record = (body ?? {}) as Record<string, unknown>;
    const intent = record.intent ?? null;
    return {
      status,
      envelope: { ok: true, data: body as unknown, intent },
    };
  }

  const record = (body ?? {}) as Record<string, unknown>;
  const rawCode =
    (typeof record.code === "string" && record.code) ||
    (typeof record.error === "string" && record.error) ||
    "INTERNAL_ERROR";
  const message =
    (typeof record.message === "string" && record.message) ||
    (typeof record.error === "string" && record.error) ||
    "Request failed";

  return {
    status,
    envelope: {
      ok: false,
      code: rawCode,
      message,
      retryable: RETRYABLE.has(rawCode) || status >= 500,
    },
  };
}

export function agentError(
  status: number,
  code: AgentErrorCode | string,
  message: string,
): NextResponse<AgentEnvelope> {
  return NextResponse.json<AgentEnvelope>(
    {
      ok: false,
      code,
      message,
      retryable: RETRYABLE.has(code) || status >= 500,
    },
    { status },
  );
}

export function agentOk<T>(
  data: T,
  status = 200,
  intent: unknown = null,
): NextResponse<AgentEnvelope<T>> {
  return NextResponse.json<AgentEnvelope<T>>(
    { ok: true, data, intent },
    { status },
  );
}
