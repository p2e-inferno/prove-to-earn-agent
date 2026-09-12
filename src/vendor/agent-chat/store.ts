import type { Json } from "@vendor/json";
import { createAgentAdminClient } from "@adapters/datastore";
import {
  agentChatActionSchema,
  type AgentChatAction,
  type AgentChatStoredMessage,
} from "@vendor/agent-chat/types";

export function normalizeActions(raw: unknown): AgentChatAction[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = agentChatActionSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function mapMessage(row: Record<string, unknown>): AgentChatStoredMessage {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    role: row.role === "user" ? "user" : "assistant",
    content: String(row.content),
    source: String(row.source) as AgentChatStoredMessage["source"],
    status: String(row.status) as AgentChatStoredMessage["status"],
    actions: normalizeActions(row.actions),
    executionId: typeof row.execution_id === "string" ? row.execution_id : null,
    createdAt: String(row.created_at),
  };
}

export async function recordOwnerTurn(input: {
  agentId: string;
  ownerUserId: string;
  clientMessageId: string;
  message: string;
  commandType?: "run_daily_quest" | null;
}) {
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase.rpc("create_agent_chat_turn", {
    p_agent_id: input.agentId,
    p_owner_user_id: input.ownerUserId,
    p_client_message_id: input.clientMessageId,
    p_message: input.message,
    p_command_type: input.commandType ?? null,
  });
  if (error) throw error;
  const result = (data ?? {}) as Record<string, unknown>;
  return {
    ok: result.success === true,
    code: typeof result.error === "string" ? result.error : null,
    conversationId: String(result.conversation_id ?? ""),
    messageId: String(result.message_id ?? ""),
    commandId: typeof result.command_id === "string" ? result.command_id : null,
    commandVersion:
      typeof result.command_version === "number"
        ? result.command_version
        : null,
    commandStatus:
      typeof result.command_status === "string" ? result.command_status : null,
    activeCommandId:
      typeof result.active_command_id === "string"
        ? result.active_command_id
        : null,
    commandSuppressed: result.command_suppressed === true,
    replayed: result.replayed === true,
  };
}

export async function appendAgentReply(input: {
  agentId: string;
  ownerUserId: string;
  content: string;
  source: "llm" | "deterministic" | "execution";
  actions?: AgentChatAction[];
  executionId?: string | null;
}): Promise<string> {
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase.rpc("append_agent_chat_message", {
    p_agent_id: input.agentId,
    p_owner_user_id: input.ownerUserId,
    p_role: "assistant",
    p_content: input.content,
    p_source: input.source,
    p_actions: (input.actions ?? []) as unknown as Json,
    p_execution_id: input.executionId ?? null,
  });
  if (error) throw error;
  return data;
}

export async function loadTrustedHistory(input: {
  agentId: string;
  ownerUserId: string;
  excludeMessageId?: string;
  limit: number;
}) {
  const supabase = createAgentAdminClient();
  const { data: conversation, error: conversationError } = await supabase
    .from("agent_conversations")
    .select("id")
    .eq("agent_id", input.agentId)
    .eq("owner_user_id", input.ownerUserId)
    .is("archived_at", null)
    .maybeSingle();
  if (conversationError) throw conversationError;
  if (!conversation) return [];

  let query = supabase
    .from("agent_chat_messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversation.id)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (input.excludeMessageId) query = query.neq("id", input.excludeMessageId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).reverse().map((row) => ({
    role: row.role as "user" | "assistant",
    content: row.content,
  }));
}

export async function latestContextualQuestRun(input: {
  agentId: string;
  ownerUserId: string;
}) {
  const supabase = createAgentAdminClient();
  const { data: conversation, error: conversationError } = await supabase
    .from("agent_conversations")
    .select("id")
    .eq("agent_id", input.agentId)
    .eq("owner_user_id", input.ownerUserId)
    .is("archived_at", null)
    .maybeSingle();
  if (conversationError) throw conversationError;
  if (!conversation) return null;

  const { data, error } = await supabase
    .from("agent_chat_messages")
    .select("role, actions")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (data?.role !== "assistant") return null;
  const runIds = new Set(
    normalizeActions(data.actions).flatMap((action) => {
      if (action.tool === "select_daily_quest" && action.prompt) {
        return [action.prompt];
      }
      return action.tool === "list_eligible_quests"
        ? (action.runIds ?? [])
        : [];
    }),
  );
  return runIds.size === 1 ? [...runIds][0]! : null;
}

export async function listAgentMessages(input: {
  agentId: string;
  ownerUserId: string;
  after?: string | null;
  before?: string | null;
  limit: number;
}) {
  const supabase = createAgentAdminClient();
  const { data: conversation, error: conversationError } = await supabase
    .from("agent_conversations")
    .select("id")
    .eq("agent_id", input.agentId)
    .eq("owner_user_id", input.ownerUserId)
    .is("archived_at", null)
    .maybeSingle();
  if (conversationError) throw conversationError;
  if (!conversation) {
    return {
      messages: [],
      next: null,
      cursor: null,
      hasMore: false,
      hasOlder: false,
      olderCursor: null,
      active: false,
      executionActive: false,
    };
  }

  const cursorInput = input.before ?? input.after;
  const separator = cursorInput?.lastIndexOf("|") ?? -1;
  const rawCreatedAt =
    separator > 0 ? cursorInput!.slice(0, separator) : cursorInput;
  const rawId = separator > 0 ? cursorInput!.slice(separator + 1) : null;
  const parsedCreatedAt = rawCreatedAt ? new Date(rawCreatedAt) : null;
  const afterCreatedAt =
    parsedCreatedAt &&
    rawCreatedAt &&
    /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(rawCreatedAt) &&
    Number.isFinite(parsedCreatedAt.getTime())
      ? rawCreatedAt
      : null;
  const afterId =
    rawId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      rawId,
    )
      ? rawId
      : null;
  let query = supabase
    .from("agent_chat_messages")
    .select(
      "id, agent_id, role, content, source, status, actions, execution_id, created_at",
    )
    .eq("conversation_id", conversation.id)
    .in("role", ["user", "assistant"]);
  if (afterCreatedAt) {
    const comparison = input.before ? "lt" : "gt";
    query = afterId
      ? query.or(
          `created_at.${comparison}.${afterCreatedAt},and(created_at.eq.${afterCreatedAt},id.${comparison}.${afterId})`,
        )
      : input.before
        ? query.lt("created_at", afterCreatedAt)
        : query.gt("created_at", afterCreatedAt);
  }
  query = query
    .order("created_at", {
      ascending: Boolean(afterCreatedAt && !input.before),
    })
    .order("id", { ascending: Boolean(afterCreatedAt && !input.before) })
    .limit(input.limit + 1);
  const [
    { data, error },
    { count: activeCount, error: commandError },
    { count: activeExecutionCount, error: executionError },
  ] = await Promise.all([
    query,
    supabase
      .from("agent_commands")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", input.agentId)
      .eq("owner_user_id", input.ownerUserId)
      .in("status", ["queued", "running", "decision_required"]),
    supabase
      .from("agent_run_executions")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", input.agentId)
      .eq("owner_user_id", input.ownerUserId)
      .in("status", ["planning", "running", "waiting_retry", "finalizing"]),
  ]);
  if (error) throw error;
  if (commandError) throw commandError;
  if (executionError) throw executionError;
  const rows = data ?? [];
  const extraRow = rows.length > input.limit;
  const forward = Boolean(afterCreatedAt && !input.before);
  const visible = rows.slice(0, input.limit);
  if (!forward) visible.reverse();
  const last = visible[visible.length - 1];
  const oldest = visible[0];
  const cursor = last ? `${last.created_at}|${last.id}` : (input.after ?? null);
  const hasMore = forward && extraRow;
  const hasOlder = !forward && extraRow;
  return {
    messages: visible.map((row) =>
      mapMessage(row as unknown as Record<string, unknown>),
    ),
    next: hasMore ? cursor : null,
    cursor,
    hasMore,
    hasOlder,
    olderCursor:
      hasOlder && oldest ? `${oldest.created_at}|${oldest.id}` : null,
    active: (activeCount ?? 0) > 0,
    executionActive: (activeExecutionCount ?? 0) > 0,
  };
}
