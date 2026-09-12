import { randomBytes } from "crypto";
import { ethers } from "ethers";
import { createAgentAdminClient } from "@adapters/datastore";
import { getLogger } from "@vendor/logger";
import {
  AGENT_CHAIN_ID,
  AGENT_CHALLENGE_TTL_SECONDS,
  AGENT_GRANT_TTL_SECONDS,
  agentAudienceOrigin,
} from "../env";
import type { AgentCapability } from "../db/agents";

const log = getLogger("agent-gateway:auth:grant");

export const AGENT_GRANT_DOMAIN_NAME = "P2E INFERNO AGENT GRANT";
export const AGENT_GRANT_DOMAIN_VERSION = "1";

export const AGENT_GRANT_TYPES = {
  AgentGrant: [
    { name: "ownerDidHash", type: "bytes32" },
    { name: "agentWallet", type: "address" },
    { name: "rewardWallet", type: "address" },
    { name: "capabilities", type: "string" },
    { name: "templateIds", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "audience", type: "string" },
    { name: "nonce", type: "string" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export interface AgentGrantMessage {
  ownerDidHash: string;
  agentWallet: string;
  rewardWallet: string;
  capabilities: string;
  templateIds: string;
  chainId: number;
  audience: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export function agentGrantDomain() {
  return {
    name: AGENT_GRANT_DOMAIN_NAME,
    version: AGENT_GRANT_DOMAIN_VERSION,
    chainId: AGENT_CHAIN_ID,
  };
}

function hashOwnerDid(ownerUserId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(ownerUserId));
}

/**
 * Build and persist the grant the agent must sign.
 *
 * The whole object is stored server-side and signed as one unit: a bare
 * signature over an unspecified message would let an agent be paired with
 * capabilities or a reward wallet the owner never approved.
 */
export async function issueAgentGrant(params: {
  ownerUserId: string;
  agentWallet: string;
  rewardWallet: string;
  capabilities: AgentCapability[];
  templateIds: string[];
}): Promise<{ grant: AgentGrantMessage; nonce: string; expiresAt: string }> {
  const nonce = `0x${randomBytes(32).toString("hex")}`;
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + AGENT_GRANT_TTL_SECONDS;

  const grant: AgentGrantMessage = {
    ownerDidHash: hashOwnerDid(params.ownerUserId),
    agentWallet: ethers.getAddress(params.agentWallet),
    rewardWallet: ethers.getAddress(params.rewardWallet),
    // Arrays are serialised so the typed data stays a flat struct; the exact
    // string is what the agent signs, so ordering is part of the commitment.
    capabilities: params.capabilities.join(","),
    templateIds: params.templateIds.join(","),
    chainId: AGENT_CHAIN_ID,
    audience: agentAudienceOrigin(),
    nonce,
    issuedAt,
    expiresAt,
  };

  const supabase = createAgentAdminClient();
  const { error } = await supabase.from("agent_challenges").insert({
    nonce,
    agent_wallet: params.agentWallet.toLowerCase(),
    purpose: "register",
    grant_payload: grant as never,
    owner_user_id: params.ownerUserId,
    expires_at: new Date(expiresAt * 1000).toISOString(),
  });

  if (error) {
    log.error("Failed to persist agent grant challenge", { error });
    throw error;
  }

  return {
    grant,
    nonce,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

export async function loadStoredGrant(nonce: string): Promise<{
  grant: AgentGrantMessage;
  ownerUserId: string;
  agentWallet: string;
  expired: boolean;
  consumed: boolean;
} | null> {
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase
    .from("agent_challenges")
    .select(
      "nonce,agent_wallet,grant_payload,owner_user_id,expires_at,consumed_at",
    )
    .eq("nonce", nonce)
    .eq("purpose", "register")
    .maybeSingle();

  if (error) throw error;
  if (!data || !data.grant_payload || !data.owner_user_id) return null;

  return {
    grant: data.grant_payload as unknown as AgentGrantMessage,
    ownerUserId: data.owner_user_id,
    agentWallet: data.agent_wallet,
    expired: Date.parse(data.expires_at) <= Date.now(),
    consumed: Boolean(data.consumed_at),
  };
}

export function recoverGrantSigner(
  grant: AgentGrantMessage,
  signature: string,
): string | null {
  try {
    return ethers.verifyTypedData(
      agentGrantDomain(),
      AGENT_GRANT_TYPES as unknown as Record<
        string,
        Array<ethers.TypedDataField>
      >,
      grant,
      signature,
    );
  } catch (error) {
    log.warn("Agent grant signature recovery failed", { error });
    return null;
  }
}

export async function issueSessionChallenge(
  agentWallet: string,
): Promise<{ nonce: string; message: string; expiresAt: string }> {
  const nonce = `0x${randomBytes(24).toString("hex")}`;
  const expiresAt = new Date(
    Date.now() + AGENT_CHALLENGE_TTL_SECONDS * 1000,
  ).toISOString();

  const supabase = createAgentAdminClient();
  const { error } = await supabase.from("agent_challenges").insert({
    nonce,
    agent_wallet: agentWallet.toLowerCase(),
    purpose: "session",
    expires_at: expiresAt,
  });
  if (error) throw error;

  const { error: purgeError } = await supabase.rpc(
    "purge_expired_agent_challenges",
    { p_older_than: "1 day" },
  );
  if (purgeError) {
    log.warn("Expired agent challenge cleanup failed", { purgeError });
  }

  return { nonce, message: sessionMessage(agentWallet, nonce), expiresAt };
}

export function sessionMessage(agentWallet: string, nonce: string): string {
  return [
    `${agentAudienceOrigin()} wants you to sign in as an agent.`,
    ``,
    `Agent: ${agentWallet.toLowerCase()}`,
    `Nonce: ${nonce}`,
    `Chain: ${AGENT_CHAIN_ID}`,
  ].join("\n");
}

export async function loadSessionChallenge(params: {
  nonce: string;
  agentWallet: string;
}): Promise<{ message: string } | null> {
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase
    .from("agent_challenges")
    .select("nonce,agent_wallet")
    .eq("nonce", params.nonce)
    .eq("purpose", "session")
    .eq("agent_wallet", params.agentWallet.toLowerCase())
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { message: sessionMessage(data.agent_wallet, data.nonce) };
}

/** Single-use: consumed atomically so a captured signature cannot be replayed. */
export async function consumeSessionChallenge(params: {
  nonce: string;
  agentWallet: string;
}): Promise<{ ok: boolean; message?: string }> {
  const supabase = createAgentAdminClient();
  const { data, error } = await supabase
    .from("agent_challenges")
    .update({ consumed_at: new Date().toISOString() })
    .eq("nonce", params.nonce)
    .eq("purpose", "session")
    .eq("agent_wallet", params.agentWallet.toLowerCase())
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("nonce,agent_wallet")
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: false };

  return { ok: true, message: sessionMessage(data.agent_wallet, data.nonce) };
}

export function recoverPersonalSigner(
  message: string,
  signature: string,
): string | null {
  try {
    return ethers.verifyMessage(message, signature);
  } catch {
    return null;
  }
}
