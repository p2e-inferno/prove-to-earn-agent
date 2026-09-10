import type { AgentCapability } from "../db/agents";

export type PriceTier = "T1" | "T2" | "T3" | "T4" | "free";

/**
 * Tiers track the server work a call costs, not read-versus-write. The quest
 * list runs one full eligibility evaluation per active run — lock-key checks
 * across every safe linked wallet plus a vendor-stage RPC read — so it is
 * genuinely the most expensive read in the system.
 */
export const TIER_PRICE: Record<PriceTier, string> = {
  free: "$0",
  T1: "$0.0001",
  T2: "$0.0003",
  T3: "$0.001",
  T4: "$0.003",
};

export interface AgentRouteSpec {
  /** Canonical route id: stable across path params, used for pricing and idempotency. */
  id: string;
  method: "GET" | "POST";
  /** Concrete path template as mounted under app/api/agent/v1. */
  path: string;
  /**
   * Capability required, or null when any active agent may call it.
   * Reporting is null: an agent whose permissions are misconfigured is exactly
   * the one whose owner most needs to hear from it.
   */
  capability: AgentCapability | null;
  tier: PriceTier;
  description: string;
}

export const AGENT_ROUTES: AgentRouteSpec[] = [
  {
    id: "executions.write",
    method: "POST",
    path: "/api/agent/v1/quests/[runId]/execution",
    capability: "quests.start",
    tier: "free",
    description: "Acquire and checkpoint a durable quest execution",
  },
  {
    id: "reports.write",
    method: "POST",
    path: "/api/agent/v1/reports",
    capability: null,
    tier: "free",
    description: "Publish a run report to the agent's owner",
  },
  {
    id: "balance.read",
    method: "GET",
    path: "/api/agent/v1/balance",
    capability: "quests.read",
    tier: "T1",
    description: "Owner xDG balance and bucket breakdown",
  },
  {
    id: "quests.detail",
    method: "GET",
    path: "/api/agent/v1/quests/[runId]",
    capability: "quests.read",
    tier: "T2",
    description: "One daily quest run with eligibility for the owner",
  },
  {
    id: "quests.list",
    method: "GET",
    path: "/api/agent/v1/quests",
    capability: "quests.read",
    tier: "T3",
    description: "Today's daily quest runs with per-run eligibility",
  },
  {
    id: "quests.start",
    method: "POST",
    path: "/api/agent/v1/quests/[runId]/start",
    capability: "quests.start",
    tier: "T3",
    description: "Enter a daily quest run and bind the execution wallet",
  },
  {
    id: "tasks.complete",
    method: "POST",
    path: "/api/agent/v1/tasks/complete",
    capability: "tasks.complete",
    tier: "T4",
    description: "Submit an on-chain transaction for task verification",
  },
  {
    id: "tasks.claim.intent",
    method: "GET",
    path: "/api/agent/v1/tasks/claim/[completionId]/intent",
    capability: "tasks.claim",
    // A read, priced as one. It was briefly a second POST to tasks.claim,
    // which charged the top tier twice for a single reward claim.
    tier: "T1",
    description:
      "The delegated attestation an agent must sign to claim a reward",
  },
  {
    id: "tasks.claim",
    method: "POST",
    path: "/api/agent/v1/tasks/claim",
    capability: "tasks.claim",
    tier: "T4",
    description: "Claim a verified task reward with a delegated attestation",
  },
  {
    id: "quests.complete",
    method: "POST",
    path: "/api/agent/v1/quests/[runId]/complete",
    capability: "quests.complete",
    tier: "T4",
    description: "Finalize a run and grant the completion key to the owner",
  },
];

export function routeSpec(id: string): AgentRouteSpec {
  const spec = AGENT_ROUTES.find((r) => r.id === id);
  if (!spec) throw new Error(`Unknown agent route id: ${id}`);
  return spec;
}

export function priceFor(id: string): string {
  return TIER_PRICE[routeSpec(id).tier];
}
