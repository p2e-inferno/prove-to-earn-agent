import { createAgentAdminClient } from "@/lib/supabase/agent-schema";
import { getLogger } from "@/lib/utils/logger";

const log = getLogger("agent-gateway:db:agents");

export type AgentCapability =
  | "quests.read"
  | "quests.start"
  | "tasks.complete"
  | "tasks.claim"
  | "quests.complete";

export interface RegisteredAgent {
  id: string;
  ownerUserId: string;
  agentWallet: string | null;
  rewardWallet: string;
  displayName: string;
  agentbookHumanId: string | null;
  walletProvider: "cdp" | "local";
  providerAccountName: string | null;
  executionMode: "owner_invoked" | "scheduled";
  maxFundingSwaps: number;
  worldStatus:
    | "not_started"
    | "in_progress"
    | "skipped"
    | "submitted"
    | "verified"
    | "failed";
  worldVerifiedAt: string | null;
  worldRegistrationTxHash: string | null;
  worldLastErrorCode: string | null;
  lifecycleVersion: number;
  readyAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  status:
    | "provisioning_wallet"
    | "ready"
    | "suspended"
    | "provisioning_failed"
    | "revoked";
}

export interface AgentPermission {
  capability: AgentCapability;
  dailyQuestTemplateId: string | null;
}

export interface AgentCapacity {
  current: number;
  limit: number;
  canCreate: boolean;
}

const AGENT_COLUMNS =
  "id,owner_user_id,agent_wallet,reward_wallet,label,agentbook_human_id,status,wallet_provider,provider_account_name,execution_mode,max_funding_swaps,world_status,world_verified_at,world_registration_tx_hash,world_last_error_code,lifecycle_version,ready_at,revoked_at,created_at";

function mapAgent(data: Record<string, unknown>): RegisteredAgent {
  return {
    id: String(data.id),
    ownerUserId: String(data.owner_user_id),
    agentWallet:
      typeof data.agent_wallet === "string" ? data.agent_wallet : null,
    rewardWallet: String(data.reward_wallet),
    displayName: String(data.label),
    agentbookHumanId:
      typeof data.agentbook_human_id === "string"
        ? data.agentbook_human_id
        : null,
    walletProvider: data.wallet_provider === "local" ? "local" : "cdp",
    providerAccountName:
      typeof data.provider_account_name === "string"
        ? data.provider_account_name
        : null,
    executionMode:
      data.execution_mode === "scheduled" ? "scheduled" : "owner_invoked",
    maxFundingSwaps: Number(data.max_funding_swaps ?? 3),
    worldStatus: String(
      data.world_status ?? "not_started",
    ) as RegisteredAgent["worldStatus"],
    worldVerifiedAt:
      typeof data.world_verified_at === "string"
        ? data.world_verified_at
        : null,
    worldRegistrationTxHash:
      typeof data.world_registration_tx_hash === "string"
        ? data.world_registration_tx_hash
        : null,
    worldLastErrorCode:
      typeof data.world_last_error_code === "string"
        ? data.world_last_error_code
        : null,
    lifecycleVersion: Number(data.lifecycle_version ?? 0),
    readyAt: typeof data.ready_at === "string" ? data.ready_at : null,
    revokedAt: typeof data.revoked_at === "string" ? data.revoked_at : null,
    createdAt: String(data.created_at),
    status: String(data.status) as RegisteredAgent["status"],
  };
}

export async function findAgentByWallet(
  agentWallet: string,
): Promise<RegisteredAgent | null> {
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase
    .from("registered_agents")
    .select(AGENT_COLUMNS)
    .eq("agent_wallet", agentWallet.toLowerCase())
    .maybeSingle();

  if (error) {
    log.error("registered_agents lookup failed", { error });
    throw error;
  }
  if (!data) return null;

  return mapAgent(data as unknown as Record<string, unknown>);
}

export async function findAgentById(
  agentId: string,
): Promise<RegisteredAgent | null> {
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase
    .from("registered_agents")
    .select(AGENT_COLUMNS)
    .eq("id", agentId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return mapAgent(data as unknown as Record<string, unknown>);
}

/**
 * The one owner-scoped agent read. service_role bypasses RLS, so the ownership
 * predicate belongs in SQL here rather than being re-derived per call site.
 */
export async function findOwnedAgent(
  agentId: string,
  ownerUserId: string,
): Promise<RegisteredAgent | null> {
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase
    .from("registered_agents")
    .select(AGENT_COLUMNS)
    .eq("id", agentId)
    .eq("owner_user_id", ownerUserId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return mapAgent(data as unknown as Record<string, unknown>);
}

export async function listAgentsForOwner(
  ownerUserId: string,
): Promise<Array<RegisteredAgent & { permissions: AgentPermission[] }>> {
  return (await listAgentsPageForOwner(ownerUserId, { limit: 100 })).agents;
}

export async function listAgentsPageForOwner(
  ownerUserId: string,
  options: { limit: number; cursor?: string | null },
): Promise<{
  agents: Array<RegisteredAgent & { permissions: AgentPermission[] }>;
  nextCursor: string | null;
}> {
  const supabase = createAgentAdminClient();
  let cursorCreatedAt: string | null = null;
  if (options.cursor) {
    const { data: cursor, error: cursorError } = await supabase
      .from("registered_agents")
      .select("id, created_at")
      .eq("id", options.cursor)
      .eq("owner_user_id", ownerUserId)
      .maybeSingle();
    if (cursorError) throw cursorError;
    cursorCreatedAt = cursor?.created_at ?? null;
  }

  const limit = Math.min(Math.max(options.limit, 1), 50);
  let query = supabase
    .from("registered_agents")
    .select(AGENT_COLUMNS)
    .eq("owner_user_id", ownerUserId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (cursorCreatedAt && options.cursor) {
    query = query.or(
      `created_at.lt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.lt.${options.cursor})`,
    );
  }
  const { data: agents, error } = await query;

  if (error) throw error;
  const rows = agents || [];
  if (rows.length === 0) return { agents: [], nextCursor: null };
  const hasMore = rows.length > limit;
  const visibleRows = rows.slice(0, limit);

  const { data: perms } = await supabase
    .from("agent_permissions")
    .select("agent_id,capability,daily_quest_template_id")
    .in(
      "agent_id",
      visibleRows.map((r) => r.id),
    );

  const byAgent = new Map<string, AgentPermission[]>();
  for (const p of perms || []) {
    const list = byAgent.get(p.agent_id) ?? [];
    list.push({
      capability: p.capability as AgentCapability,
      dailyQuestTemplateId: p.daily_quest_template_id,
    });
    byAgent.set(p.agent_id, list);
  }

  const mapped = visibleRows.map((row) => {
    const agent = mapAgent(row as unknown as Record<string, unknown>);
    return { ...agent, permissions: byAgent.get(agent.id) ?? [] };
  });
  return {
    agents: mapped,
    nextCursor: hasMore ? (mapped[mapped.length - 1]?.id ?? null) : null,
  };
}

export async function agentCapacityForOwner(
  ownerUserId: string,
  limit: number,
): Promise<AgentCapacity> {
  const supabase = createAgentAdminClient();
  const { count, error } = await supabase
    .from("registered_agents")
    .select("id", { count: "exact", head: true })
    .eq("owner_user_id", ownerUserId)
    .neq("status", "revoked");

  if (error) throw error;
  const current = count ?? 0;
  return { current, limit, canCreate: current < limit };
}

export async function createPlatformAgent(input: {
  ownerUserId: string;
  rewardWallet: string;
  displayName: string;
  capabilities: AgentCapability[];
  templateIds: string[];
  maxFundingSwaps: number;
  ownerLimit: number;
}): Promise<
  | { ok: true; agent: RegisteredAgent; capacity: AgentCapacity }
  | { ok: false; code: string; capacity?: AgentCapacity }
> {
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase.rpc("create_platform_agent", {
    p_owner_user_id: input.ownerUserId,
    p_reward_wallet: input.rewardWallet.toLowerCase(),
    p_label: input.displayName,
    p_capabilities: input.capabilities,
    p_template_ids: input.templateIds.length ? input.templateIds : null,
    p_max_funding_swaps: input.maxFundingSwaps,
    p_owner_limit: input.ownerLimit,
  });

  if (error) throw error;
  const result = (data ?? {}) as Record<string, unknown>;
  if (result.success !== true) {
    const current = Number(result.current);
    const limit = Number(result.limit);
    return {
      ok: false,
      code: String(result.error ?? "AGENT_CREATE_FAILED"),
      ...(Number.isFinite(current) && Number.isFinite(limit)
        ? {
            capacity: {
              current,
              limit,
              canCreate: current < limit,
            },
          }
        : {}),
    };
  }

  const agent = await findAgentById(String(result.agent_id));
  if (!agent) throw new Error("Created agent could not be reloaded");
  return {
    ok: true,
    agent,
    capacity: {
      current: Number(result.current),
      limit: Number(result.limit),
      canCreate: Number(result.current) < Number(result.limit),
    },
  };
}

export async function updatePlatformAgent(
  agentId: string,
  ownerUserId: string,
  input: { displayName?: string; maxFundingSwaps?: number },
): Promise<RegisteredAgent | null> {
  const current = await findAgentById(agentId);
  if (
    !current ||
    current.ownerUserId !== ownerUserId ||
    current.status === "revoked"
  ) {
    return null;
  }
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase.rpc("update_platform_agent_policy", {
    p_agent_id: agentId,
    p_owner_user_id: ownerUserId,
    p_label: input.displayName ?? current.displayName,
    p_max_funding_swaps: input.maxFundingSwaps ?? current.maxFundingSwaps,
    p_expected_version: current.lifecycleVersion,
  });
  if (error) throw error;
  if (!data) return null;
  return findAgentById(agentId);
}

export async function loadPermissions(
  agentId: string,
): Promise<AgentPermission[]> {
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase
    .from("agent_permissions")
    .select("capability,daily_quest_template_id")
    .eq("agent_id", agentId);

  if (error) throw error;
  return (data || []).map((row) => ({
    capability: row.capability as AgentCapability,
    dailyQuestTemplateId: row.daily_quest_template_id,
  }));
}

// A null template grants all templates; an empty permission set grants nothing.
export function hasCapability(
  permissions: AgentPermission[],
  capability: AgentCapability,
  templateId?: string | null,
): boolean {
  return permissions.some((p) => {
    if (p.capability !== capability) return false;
    if (p.dailyQuestTemplateId === null) return true;
    return Boolean(templateId) && p.dailyQuestTemplateId === templateId;
  });
}

export async function revokeAgent(
  agentId: string,
  ownerUserId: string,
): Promise<boolean> {
  const current = await findAgentById(agentId);
  if (
    !current ||
    current.ownerUserId !== ownerUserId ||
    current.status === "revoked"
  ) {
    return false;
  }
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase.rpc("revoke_platform_agent", {
    p_agent_id: agentId,
    p_owner_user_id: ownerUserId,
    p_expected_version: current.lifecycleVersion,
  });
  if (error) throw error;
  return data;
}

export async function templateIdForRun(runId: string): Promise<string | null> {
  const supabase = createAgentAdminClient();
  const { data } = await supabase
    .from("daily_quest_runs")
    .select("daily_quest_template_id")
    .eq("id", runId)
    .maybeSingle();
  return data?.daily_quest_template_id ?? null;
}

export async function templateIdForCompletion(
  completionId: string,
  userId: string,
): Promise<string | null> {
  const supabase = createAgentAdminClient();
  const { data: completion } = await supabase
    .from("user_daily_task_completions")
    .select("daily_quest_run_id")
    .eq("id", completionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!completion) return null;
  return templateIdForRun(completion.daily_quest_run_id);
}
