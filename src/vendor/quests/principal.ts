/**
 * Vendored as-is from the private platform (`lib/quests/principal.ts`) — a
 * pure envelope type with no platform-specific logic. Every adapter and
 * route in this repo speaks in `QuestPrincipal` / `ServiceResult`.
 */

export interface QuestPrincipal {
  /** Privy DID of the owning human, for both actor kinds. */
  userId: string;
  /** Address that sends transactions and binds the run. */
  executionWallet: string;
  /** Owner-approved payout address: quest key, bonus seat, attestation recipient. */
  rewardWallet: string;
  actorKind: "human" | "agent";
  /** Present only for agents; used for audit and sybil correlation. */
  agentId?: string;
}

export type ServiceResult<T = unknown> = {
  status: number;
  body: T;
};

export function ok<T>(body: T, status = 200): ServiceResult<T> {
  return { status, body };
}

export function fail(
  status: number,
  code: string,
  message?: string,
  extra?: Record<string, unknown>,
): ServiceResult<Record<string, unknown>> {
  return {
    status,
    body: { error: code, code, message: message ?? code, ...(extra ?? {}) },
  };
}

export function humanPrincipal(
  userId: string,
  walletAddress: string,
): QuestPrincipal {
  return {
    userId,
    executionWallet: walletAddress,
    rewardWallet: walletAddress,
    actorKind: "human",
  };
}
