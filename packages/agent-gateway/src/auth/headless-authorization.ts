import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { canonicalize } from "json-canonicalize";
import { ethers } from "ethers";
import {
  authorizationPolicyV1Schema,
  authorizationTypedMessageSchema,
  type AuthorizationPolicyV1,
  type AuthorizationTypedMessage,
} from "@p2e/agent-contracts";
import { createHeadlessAgentAdminClient } from "@/lib/supabase/headless-agent-schema";
import { findOwnedAgent, loadPermissions } from "../db/agents";
import {
  AGENT_CHAIN_ID,
  headlessAgentResource,
  headlessCredentialPepperKeyring,
} from "../env";

export const HEADLESS_AUTHORIZATION_DOMAIN = {
  name: "P2E Inferno Agent Authorization",
  version: "1",
};

export const HEADLESS_AUTHORIZATION_TYPES = {
  AgentAuthorization: [
    { name: "authorizationId", type: "string" },
    { name: "policyVersion", type: "uint32" },
    { name: "ownerSubjectHash", type: "bytes32" },
    { name: "agentId", type: "string" },
    { name: "agentWallet", type: "address" },
    { name: "rewardWallet", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "resource", type: "string" },
    { name: "policyHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export const HEADLESS_CREDENTIAL_ROTATION_TYPES = {
  AgentCredentialRotation: [
    { name: "agentId", type: "string" },
    { name: "authorizationId", type: "string" },
    { name: "ownerSubjectHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

const ACTION_VERSIONS = new Map<string, number>([
  ["p2e_uniswap_swap", 2],
  ["p2e_vendor_buy", 2],
  ["p2e_vendor_sell", 2],
  ["p2e_vendor_light_up", 2],
  ["p2e_vendor_level_up", 2],
  ["p2e_eth_transfer", 1],
  ["p2e_erc20_transfer", 1],
  ["p2e_deploy_lock", 1],
  ["p2e_daily_checkin", 1],
  ["p2e_gas_drop", 1],
  ["approval.erc20", 1],
  ["approval.permit2", 1],
  ["x402.payment", 1],
  ["quest.claim", 1],
  ["quest.settle", 1],
]);

export interface HeadlessAuthorization {
  id: string;
  agentId: string;
  ownerUserId: string;
  ownerWallet: string;
  policy: AuthorizationPolicyV1;
  policyHash: string;
  status: string;
  expiresAt: string;
  activatedAt: string | null;
}

export function canonicalPolicyHash(policy: AuthorizationPolicyV1): string {
  return ethers.keccak256(ethers.toUtf8Bytes(canonicalize(policy)));
}

function ownerSubjectHash(ownerUserId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(ownerUserId));
}

function typedDomain(chainId = AGENT_CHAIN_ID) {
  return { ...HEADLESS_AUTHORIZATION_DOMAIN, chainId };
}

async function validatePolicyScope(agentId: string, policy: AuthorizationPolicyV1) {
  for (const action of policy.actions) {
    if (ACTION_VERSIONS.get(action.actionId) !== action.version) {
      throw new Error("ACTION_POLICY_VERSION_UNAVAILABLE");
    }
  }

  const permissions = await loadPermissions(agentId);
  const scopedTemplates = new Set(
    permissions
      .map((permission) => permission.dailyQuestTemplateId)
      .filter((templateId): templateId is string => Boolean(templateId)),
  );
  const hasUnscopedQuestPermission = permissions.some(
    (permission) =>
      permission.dailyQuestTemplateId === null &&
      permission.capability !== "quests.read",
  );
  if (
    !hasUnscopedQuestPermission &&
    policy.templateIds.some((templateId) => !scopedTemplates.has(templateId))
  ) {
    throw new Error("TEMPLATE_SCOPE_DENIED");
  }
}

export async function createAuthorizationDraft(input: {
  agentId: string;
  ownerUserId: string;
  ownerWallet: string;
  policy: unknown;
  expiresAt?: string;
}) {
  const policy = authorizationPolicyV1Schema.parse(input.policy);
  const resource = headlessAgentResource();
  if (policy.chain !== `eip155:${AGENT_CHAIN_ID}` || policy.resource !== resource) {
    throw new Error("POLICY_RESOURCE_MISMATCH");
  }

  const agent = await findOwnedAgent(input.agentId, input.ownerUserId);
  if (!agent || agent.status !== "ready" || !agent.agentWallet) {
    throw new Error("AGENT_NOT_READY");
  }
  if (input.ownerWallet.toLowerCase() === agent.agentWallet.toLowerCase()) {
    throw new Error("OWNER_WALLET_INVALID");
  }
  await validatePolicyScope(agent.id, policy);

  const now = Math.floor(Date.now() / 1000);
  const requestedExpiry = input.expiresAt
    ? Math.floor(Date.parse(input.expiresAt) / 1000)
    : now + 30 * 24 * 60 * 60;
  if (
    !Number.isSafeInteger(requestedExpiry) ||
    requestedExpiry <= now ||
    requestedExpiry > now + 90 * 24 * 60 * 60
  ) {
    throw new Error("AUTHORIZATION_EXPIRY_INVALID");
  }

  const authorizationId = randomUUID();
  const nonce = `0x${randomBytes(32).toString("hex")}`;
  const policyHash = canonicalPolicyHash(policy);
  const message = authorizationTypedMessageSchema.parse({
    authorizationId,
    policyVersion: 1,
    ownerSubjectHash: ownerSubjectHash(input.ownerUserId),
    agentId: agent.id,
    agentWallet: ethers.getAddress(agent.agentWallet),
    rewardWallet: ethers.getAddress(agent.rewardWallet),
    chainId: AGENT_CHAIN_ID,
    resource,
    policyHash,
    nonce,
    issuedAt: now,
    expiresAt: requestedExpiry,
  });

  const db = createHeadlessAgentAdminClient();
  const { error } = await db.from("agent_authorizations").insert({
    id: authorizationId,
    agent_id: agent.id,
    owner_user_id: input.ownerUserId,
    owner_wallet: input.ownerWallet.toLowerCase(),
    agent_wallet: agent.agentWallet.toLowerCase(),
    reward_wallet: agent.rewardWallet.toLowerCase(),
    policy_version: 1,
    policy,
    policy_hash: policyHash.toLowerCase(),
    resource,
    chain_id: AGENT_CHAIN_ID,
    nonce,
    issued_at: new Date(now * 1000).toISOString(),
    expires_at: new Date(requestedExpiry * 1000).toISOString(),
    draft_expires_at: new Date((now + 10 * 60) * 1000).toISOString(),
    status: "draft",
  });
  if (error) throw error;

  return {
    authorizationId,
    expiresAt: new Date(requestedExpiry * 1000).toISOString(),
    draftExpiresAt: new Date((now + 10 * 60) * 1000).toISOString(),
    policy,
    typedData: {
      domain: typedDomain(),
      types: HEADLESS_AUTHORIZATION_TYPES,
      primaryType: "AgentAuthorization" as const,
      message,
    },
  };
}

function authorizationFromRow(row: Record<string, unknown>): HeadlessAuthorization {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    ownerUserId: String(row.owner_user_id),
    ownerWallet: String(row.owner_wallet),
    policy: authorizationPolicyV1Schema.parse(row.policy),
    policyHash: String(row.policy_hash),
    status: String(row.status),
    expiresAt: String(row.expires_at),
    activatedAt: typeof row.activated_at === "string" ? row.activated_at : null,
  };
}

export async function activateAuthorization(input: {
  authorizationId: string;
  agentId: string;
  ownerUserId: string;
  ownerWallet: string;
  signature: string;
}) {
  const db = createHeadlessAgentAdminClient();
  const { data, error } = await db
    .from("agent_authorizations")
    .select("*")
    .eq("id", input.authorizationId)
    .eq("agent_id", input.agentId)
    .eq("owner_user_id", input.ownerUserId)
    .eq("owner_wallet", input.ownerWallet.toLowerCase())
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("AUTHORIZATION_NOT_FOUND");

  const message: AuthorizationTypedMessage = {
    authorizationId: data.id,
    policyVersion: 1,
    ownerSubjectHash: ownerSubjectHash(data.owner_user_id),
    agentId: data.agent_id,
    agentWallet: ethers.getAddress(data.agent_wallet),
    rewardWallet: ethers.getAddress(data.reward_wallet),
    chainId: Number(data.chain_id),
    resource: data.resource,
    policyHash: data.policy_hash,
    nonce: data.nonce,
    issuedAt: Math.floor(Date.parse(data.issued_at) / 1000),
    expiresAt: Math.floor(Date.parse(data.expires_at) / 1000),
  };
  let recovered: string;
  try {
    recovered = ethers.verifyTypedData(
      typedDomain(message.chainId),
      HEADLESS_AUTHORIZATION_TYPES as unknown as Record<
        string,
        ethers.TypedDataField[]
      >,
      message,
      input.signature,
    );
  } catch {
    throw new Error("SIGNATURE_INVALID");
  }
  if (recovered.toLowerCase() !== input.ownerWallet.toLowerCase()) {
    throw new Error("SIGNATURE_INVALID");
  }

  const result = await db.rpc("activate_agent_authorization", {
    p_authorization_id: data.id,
    p_agent_id: data.agent_id,
    p_owner_user_id: data.owner_user_id,
    p_owner_wallet: data.owner_wallet,
    p_policy_hash: data.policy_hash,
    p_nonce: data.nonce,
    p_owner_signature: input.signature,
  });
  if (result.error) throw result.error;
  return result.data as Record<string, unknown>;
}

export async function loadActiveAuthorization(agentId: string) {
  const db = createHeadlessAgentAdminClient();
  const { data, error } = await db
    .from("agent_authorizations")
    .select("*")
    .eq("agent_id", agentId)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  return data ? authorizationFromRow(data as unknown as Record<string, unknown>) : null;
}

export async function loadOwnerAuthorization(agentId: string, ownerUserId: string) {
  const db = createHeadlessAgentAdminClient();
  const { data, error } = await db
    .from("agent_authorizations")
    .select("*")
    .eq("agent_id", agentId)
    .eq("owner_user_id", ownerUserId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? authorizationFromRow(data as unknown as Record<string, unknown>) : null;
}

function credentialDigest(secret: string, pepper: string): string {
  return createHmac("sha256", pepper).update(secret, "utf8").digest("hex");
}

export async function createCredentialRotationDraft(input: {
  agentId: string;
  ownerUserId: string;
  ownerWallet: string;
}) {
  const authorization = await loadActiveAuthorization(input.agentId);
  if (
    !authorization ||
    authorization.ownerUserId !== input.ownerUserId ||
    authorization.ownerWallet !== input.ownerWallet.toLowerCase()
  ) {
    throw new Error("AUTHORIZATION_REQUIRED");
  }
  const challengeId = randomUUID();
  const nonce = `0x${randomBytes(32).toString("hex")}`;
  const expiresAt = Math.floor(Date.now() / 1000) + 10 * 60;
  const db = createHeadlessAgentAdminClient();
  const { error } = await db.from("agent_credential_rotation_challenges").insert({
    id: challengeId,
    agent_id: input.agentId,
    owner_user_id: input.ownerUserId,
    owner_wallet: input.ownerWallet.toLowerCase(),
    authorization_id: authorization.id,
    nonce,
    expires_at: new Date(expiresAt * 1000).toISOString(),
  });
  if (error) throw error;
  return {
    challengeId,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    typedData: {
      domain: typedDomain(),
      types: HEADLESS_CREDENTIAL_ROTATION_TYPES,
      primaryType: "AgentCredentialRotation" as const,
      message: {
        agentId: input.agentId,
        authorizationId: authorization.id,
        ownerSubjectHash: ownerSubjectHash(input.ownerUserId),
        nonce,
        expiresAt,
      },
    },
  };
}

export async function rotateHeadlessCredential(input: {
  agentId: string;
  ownerUserId: string;
  ownerWallet: string;
  challengeId: string;
  signature: string;
}) {
  const db = createHeadlessAgentAdminClient();
  const { data: challenge, error: challengeError } = await db
    .from("agent_credential_rotation_challenges")
    .select("*")
    .eq("id", input.challengeId)
    .eq("agent_id", input.agentId)
    .eq("owner_user_id", input.ownerUserId)
    .eq("owner_wallet", input.ownerWallet.toLowerCase())
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (challengeError) throw challengeError;
  if (!challenge) throw new Error("CREDENTIAL_CHALLENGE_INVALID");
  const expiresAt = Math.floor(Date.parse(challenge.expires_at) / 1000);
  let recovered: string;
  try {
    recovered = ethers.verifyTypedData(
      typedDomain(),
      HEADLESS_CREDENTIAL_ROTATION_TYPES as unknown as Record<
        string,
        ethers.TypedDataField[]
      >,
      {
        agentId: challenge.agent_id,
        authorizationId: challenge.authorization_id,
        ownerSubjectHash: ownerSubjectHash(challenge.owner_user_id),
        nonce: challenge.nonce,
        expiresAt,
      },
      input.signature,
    );
  } catch {
    throw new Error("SIGNATURE_INVALID");
  }
  if (recovered.toLowerCase() !== input.ownerWallet.toLowerCase()) {
    throw new Error("SIGNATURE_INVALID");
  }

  const keyring = headlessCredentialPepperKeyring();
  const clientId = `p2e_agent_${randomUUID().replace(/-/g, "")}`;
  const clientSecret = `p2e_secret_${randomBytes(32).toString("base64url")}`;
  const digest = credentialDigest(
    clientSecret,
    keyring.peppers.get(keyring.currentKid)!,
  );
  const { data, error } = await db.rpc(
    "rotate_agent_authorization_credential",
    {
      p_challenge_id: input.challengeId,
      p_agent_id: input.agentId,
      p_owner_user_id: input.ownerUserId,
      p_client_id: clientId,
      p_secret_digest: digest,
      p_pepper_kid: keyring.currentKid,
      p_scopes: [
        "agent:read",
        "quests:read",
        "quests:run",
        "quests:decide",
        "quests:cancel",
      ],
      p_expires_at: null,
    },
  );
  if (error) throw error;
  const outcome = data as Record<string, unknown>;
  if (outcome.outcome !== "active") {
    throw new Error(String(outcome.outcome ?? "CREDENTIAL_ROTATION_FAILED"));
  }
  return { clientId, clientSecret, scopes: ["agent:read", "quests:read", "quests:run", "quests:decide", "quests:cancel"] };
}

export async function verifyHeadlessCredential(clientId: string, clientSecret: string) {
  const db = createHeadlessAgentAdminClient();
  const { data, error } = await db
    .from("agent_authorization_credentials")
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  if (!data || (data.expires_at && Date.parse(data.expires_at) <= Date.now())) return null;

  const keyring = headlessCredentialPepperKeyring();
  const pepper = keyring.peppers.get(data.pepper_kid);
  if (!pepper) return null;
  const actual = Buffer.from(credentialDigest(clientSecret, pepper), "hex");
  const expected = Buffer.from(data.secret_digest, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  const authorization = await loadActiveAuthorization(data.agent_id);
  if (!authorization || data.authorization_id !== authorization.id) return null;
  const agent = await findOwnedAgent(data.agent_id, authorization.ownerUserId);
  if (!agent || agent.status !== "ready") return null;

  await db
    .from("agent_authorization_credentials")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);
  return { credential: data, authorization, agent };
}

export async function credentialIsActive(
  credentialId: string,
  agentId: string,
  authorizationId: string,
): Promise<boolean> {
  const db = createHeadlessAgentAdminClient();
  const { data, error } = await db
    .from("agent_authorization_credentials")
    .select("id")
    .eq("id", credentialId)
    .eq("agent_id", agentId)
    .eq("authorization_id", authorizationId)
    .eq("status", "active")
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function revokeHeadlessAccess(input: {
  agentId: string;
  ownerUserId: string;
  revokeAuthorization: boolean;
}) {
  const db = createHeadlessAgentAdminClient();
  const { data, error } = await db.rpc("revoke_agent_headless_access", {
    p_agent_id: input.agentId,
    p_owner_user_id: input.ownerUserId,
    p_revoke_authorization: input.revokeAuthorization,
  });
  if (error) throw error;
  return data as Record<string, unknown>;
}
