import { SchemaEncoder } from "@ethereum-attestation-service/eas-sdk";
import { createAgentAdminClient } from "@adapters/datastore";
import { getLogger } from "@vendor/logger";
import { isEASEnabled } from "@adapters/attestation";
import {
  resolveNetworkConfig,
  getDefaultNetworkName,
} from "@adapters/attestation";
import { resolveSchemaUID } from "@adapters/attestation";
import type { QuestPrincipal } from "@vendor/quests/principal";

const log = getLogger("agent-gateway:intents:attestation");

const DEADLINE_SECONDS = 3600;
const ZERO_REF_UID =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

export type IntentResult =
  | { ok: true; intent: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string };

/**
 * Build the exact delegated-attestation request the agent must sign.
 *
 * The server encodes the schema data because the encoding must match the
 * deployed schema definition; the agent only signs. Returning the EAS request
 * fields rather than a hand-rolled EIP-712 payload keeps the runner on the same
 * SDK path the browser client uses.
 */
export async function buildRewardClaimIntent(
  principal: QuestPrincipal,
  completionId: string,
): Promise<IntentResult> {
  if (!isEASEnabled()) {
    return {
      ok: false,
      status: 400,
      code: "EAS_DISABLED",
      message:
        "Attestations are disabled; submit the claim without a signature",
    };
  }

  const supabase = createAgentAdminClient();

  const { data: completion } = await supabase
    .from("user_daily_task_completions")
    .select("id,daily_quest_run_id,daily_quest_run_task_id")
    .eq("id", completionId)
    .eq("user_id", principal.userId)
    .maybeSingle();

  if (!completion) {
    return {
      ok: false,
      status: 404,
      code: "COMPLETION_NOT_FOUND",
      message: "Completion not found",
    };
  }

  const { data: task } = await supabase
    .from("daily_quest_run_tasks")
    .select("id,task_type,reward_amount")
    .eq("id", completion.daily_quest_run_task_id)
    .maybeSingle();

  const { data: run } = await supabase
    .from("daily_quest_runs")
    .select("daily_quest_template_id")
    .eq("id", completion.daily_quest_run_id)
    .maybeSingle();

  if (!task || !run) {
    return {
      ok: false,
      status: 404,
      code: "TASK_NOT_FOUND",
      message: "Task context missing",
    };
  }

  const { data: template } = await supabase
    .from("daily_quest_templates")
    .select("id,lock_address")
    .eq("id", run.daily_quest_template_id)
    .maybeSingle();

  if (!template?.lock_address) {
    return {
      ok: false,
      status: 400,
      code: "LOCK_NOT_CONFIGURED",
      message: "Quest lock address missing",
    };
  }

  const networkName = getDefaultNetworkName();
  const networkConfig = await resolveNetworkConfig(networkName);
  if (!networkConfig) {
    return {
      ok: false,
      status: 503,
      code: "EAS_NETWORK_UNAVAILABLE",
      message: `Network ${networkName} is not configured`,
    };
  }

  const schemaUid = await resolveSchemaUID(
    "quest_task_reward_claim",
    networkName,
  );
  if (!schemaUid) {
    return {
      ok: false,
      status: 503,
      code: "EAS_SCHEMA_UNAVAILABLE",
      message: "Reward claim schema is not deployed on this network",
    };
  }

  const schemaString = [
    "string questId",
    "string taskId",
    "string taskType",
    "address userAddress",
    "address questLockAddress",
    "uint256 rewardAmount",
    "uint256 claimTimestamp",
  ].join(",");

  const encoder = new SchemaEncoder(schemaString);
  const encodedData = encoder.encodeData([
    { name: "questId", type: "string", value: String(template.id) },
    { name: "taskId", type: "string", value: String(task.id) },
    { name: "taskType", type: "string", value: String(task.task_type || "") },
    // The owner's payout address is the subject of the attestation; the agent
    // is only the signer.
    { name: "userAddress", type: "address", value: principal.rewardWallet },
    {
      name: "questLockAddress",
      type: "address",
      value: template.lock_address,
    },
    {
      name: "rewardAmount",
      type: "uint256",
      value: BigInt(Number(task.reward_amount || 0)),
    },
    {
      name: "claimTimestamp",
      type: "uint256",
      value: BigInt(Math.floor(Date.now() / 1000)),
    },
  ]);

  log.debug("Built reward claim intent", { completionId, schemaUid });

  return {
    ok: true,
    intent: {
      type: "eas.delegated_attestation",
      purpose: "quest_task_reward_claim",
      submitTo: "/api/agent/v1/tasks/claim",
      easContractAddress: networkConfig.easContractAddress,
      chainId: networkConfig.chainId,
      network: networkName,
      request: {
        schema: schemaUid,
        recipient: principal.rewardWallet,
        // Signer must be the agent's own wallet: the gateway checks the
        // attester against the acting wallet before it reaches EAS.
        attester: principal.executionWallet,
        expirationTime: "0",
        revocable: false,
        refUID: ZERO_REF_UID,
        data: encodedData,
        deadline: String(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS),
        value: "0",
      },
      resubmit: {
        completionId,
        attestationSignatureShape: {
          signature: "0x… rsv",
          attester: principal.executionWallet,
          recipient: principal.rewardWallet,
          schemaUid,
          data: encodedData,
          deadline: "<deadline>",
          expirationTime: "0",
          revocable: false,
          refUID: ZERO_REF_UID,
          chainId: networkConfig.chainId,
          network: networkName,
        },
      },
    },
  };
}
