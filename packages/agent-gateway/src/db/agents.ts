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
  agentWallet: string;
  rewardWallet: string;
  label: string;
  agentbookHumanId: string | null;
  status: "active" | "suspended" | "revoked";
}

export interface AgentPermission {
  capability: AgentCapability;
  dailyQuestTemplateId: string | null;
}

export async function findAgentByWallet(
  agentWallet: string,
): Promise<RegisteredAgent | null> {
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase
    .from("registered_agents")
    .select(
      "id,owner_user_id,agent_wallet,reward_wallet,label,agentbook_human_id,status",
    )
    .eq("agent_wallet", agentWallet.toLowerCase())
    .maybeSingle();

  if (error) {
    log.error("registered_agents lookup failed", { error });
    throw error;
  }
  if (!data) return null;

  return {
    id: data.id,
    ownerUserId: data.owner_user_id,
    agentWallet: data.agent_wallet,
    rewardWallet: data.reward_wallet,
    label: data.label,
    agentbookHumanId: data.agentbook_human_id,
    status: data.status as RegisteredAgent["status"],
  };
}

export async function findAgentById(
  agentId: string,
): Promise<RegisteredAgent | null> {
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase
    .from("registered_agents")
    .select(
      "id,owner_user_id,agent_wallet,reward_wallet,label,agentbook_human_id,status",
    )
    .eq("id", agentId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: data.id,
    ownerUserId: data.owner_user_id,
    agentWallet: data.agent_wallet,
    rewardWallet: data.reward_wallet,
    label: data.label,
    agentbookHumanId: data.agentbook_human_id,
    status: data.status as RegisteredAgent["status"],
  };
}

export async function listAgentsForOwner(
  ownerUserId: string,
): Promise<Array<RegisteredAgent & { permissions: AgentPermission[] }>> {
  const supabase = createAgentAdminClient();
  const { data: agents, error } = await supabase
    .from("registered_agents")
    .select(
      "id,owner_user_id,agent_wallet,reward_wallet,label,agentbook_human_id,status",
    )
    .eq("owner_user_id", ownerUserId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  const rows = agents || [];
  if (rows.length === 0) return [];

  const { data: perms } = await supabase
    .from("agent_permissions")
    .select("agent_id,capability,daily_quest_template_id")
    .in(
      "agent_id",
      rows.map((r) => r.id),
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

  return rows.map((r) => ({
    id: r.id,
    ownerUserId: r.owner_user_id,
    agentWallet: r.agent_wallet,
    rewardWallet: r.reward_wallet,
    label: r.label,
    agentbookHumanId: r.agentbook_human_id,
    status: r.status as RegisteredAgent["status"],
    permissions: byAgent.get(r.id) ?? [],
  }));
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

/**
 * Deny by default: a capability requires a matching row. An unscoped row
 * (`daily_quest_template_id IS NULL`) grants the capability across templates;
 * an empty permission set grants nothing.
 */
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
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase
    .from("registered_agents")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("id", agentId)
    .eq("owner_user_id", ownerUserId)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

/** Template id for a run, needed to evaluate template-scoped capabilities. */
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
