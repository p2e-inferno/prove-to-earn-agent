import { createAgentAdminClient } from "@adapters/datastore";

export type AgentLifecycleRpcResult = Record<string, unknown>;

/**
 * Runs one lifecycle-versioned agent RPC, retrying once against a reloaded
 * version. A revoked or missing agent stops the retry instead of looping: its
 * version will keep moving and no caller wants to win that race.
 */
export async function callWithAgentLifecycleVersion(input: {
  agentId: string;
  ownerUserId: string;
  expectedVersion: number;
  // A Supabase RPC builder is a thenable, not a Promise.
  call: (
    expectedVersion: number,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
}): Promise<AgentLifecycleRpcResult> {
  const supabase = createAgentAdminClient();
  let expectedVersion = input.expectedVersion;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await input.call(expectedVersion);
    if (error) throw error;
    const result = (data ?? {}) as AgentLifecycleRpcResult;
    if (result.success === true || result.error !== "VERSION_CONFLICT") {
      return result;
    }

    const { data: current, error: reloadError } = await supabase
      .from("registered_agents")
      .select("lifecycle_version, status")
      .eq("id", input.agentId)
      .eq("owner_user_id", input.ownerUserId)
      .maybeSingle();
    if (reloadError) throw reloadError;
    if (!current || current.status === "revoked") return result;
    expectedVersion = current.lifecycle_version;
  }

  return { success: false, error: "VERSION_CONFLICT" };
}
