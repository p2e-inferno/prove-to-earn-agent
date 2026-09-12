import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { canonicalize } from "json-canonicalize";
import { ethers } from "ethers";
import {
  authorizationPolicyV1Schema,
  authorizationTypedMessageSchema,
  type AuthorizationPolicyV1,
  type AuthorizationTypedMessage,
} from "@p2e/agent-contracts";
import { createHeadlessAgentAdminClient } from "@adapters/datastore";
import { DEFAULT_SLIPPAGE_BPS } from "@vendor/uniswap/constants";
import {
  findOwnedAgent,
  hasCapability,
  loadPermissions,
  type AgentPermission,
} from "../db/agents";
import {
  AGENT_CHAIN_ID,
  headlessAgentResource,
  headlessCredentialPepperKeyring,
} from "../env";

const NO_EXPIRY_SENTINEL = 0;

export const DAILY_QUEST_CAPABILITIES = [
  "quests.read",
  "quests.start",
  "tasks.complete",
  "tasks.claim",
  "quests.complete",
] as const;

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

export interface HeadlessAuthorization {
  id: string;
  agentId: string;
  ownerUserId: string;
  ownerWallet: string;
  policy: AuthorizationPolicyV1;
  policyHash: string;
  status: string;
  expiresAt: string | null;
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

async function validatePolicyScope(
  agentId: string,
  policy: AuthorizationPolicyV1,
) {
  const permissions = await loadPermissions(agentId);
  if (
    policy.templateIds.some(
      (templateId) => !hasLiveDailyQuestPermission(permissions, templateId),
    )
  ) {
    throw new Error("TEMPLATE_SCOPE_DENIED");
  }
}

export function hasLiveDailyQuestPermission(
  permissions: AgentPermission[],
  templateId: string,
): boolean {
  return DAILY_QUEST_CAPABILITIES.every((capability) =>
    hasCapability(permissions, capability, templateId),
  );
}

export function headlessPolicyAllowsTemplate(
  policy: AuthorizationPolicyV1,
  templateId: string,
): boolean {
  return (
    policy.templateIds.length === 0 || policy.templateIds.includes(templateId)
  );
}

const DEFAULT_POLICY_LIMITS = {
  maxGasPerActionRaw: "2000000000000000", // 0.002 ETH
  maxGasPerRunRaw: "10000000000000000", // 0.01 ETH
  maxGasRolling24hRaw: "30000000000000000", // 0.03 ETH
  maxX402PerRequestRaw: "50000", // $0.05 (6-decimal USDC raw units)
  maxX402PerRunRaw: "500000", // $0.50
  maxX402Rolling24hRaw: "2000000", // $2.00
  maxServiceFeePerActionRaw: "50000",
  maxServiceFeePerRunRaw: "500000",
  maxServiceFeeRolling24hRaw: "2000000",
  minNativeReserveRaw: "2000000000000000", // 0.002 ETH kept for gas
  maxFundingSwapsPerRun: 20,
  maxSlippageBps: DEFAULT_SLIPPAGE_BPS,
} as const;

function normalizePolicyInput(rawPolicy: unknown): unknown {
  const partial =
    rawPolicy && typeof rawPolicy === "object"
      ? (rawPolicy as Record<string, unknown>)
      : {};
  return {
    ...DEFAULT_POLICY_LIMITS,
    templateIds: [],
    actions: [],
    ...partial,
    version: 1,
    chain: `eip155:${AGENT_CHAIN_ID}`,
    resource: headlessAgentResource(),
  };
}

export async function createAuthorizationDraft(input: {
  agentId: string;
  ownerUserId: string;
  ownerWallet: string;
  policy: unknown;
  expiresAt?: string;
}) {
  const policy = authorizationPolicyV1Schema.parse(
    normalizePolicyInput(input.policy),
  );
  const resource = headlessAgentResource();

  const agent = await findOwnedAgent(input.agentId, input.ownerUserId);
  if (!agent || agent.status !== "ready" || !agent.agentWallet) {
    throw new Error("AGENT_NOT_READY");
  }
  if (input.ownerWallet.toLowerCase() === agent.agentWallet.toLowerCase()) {
    throw new Error("OWNER_WALLET_INVALID");
  }
  await validatePolicyScope(agent.id, policy);

  const now = Math.floor(Date.now() / 1000);
  // Owner-set expiry is optional: the product intent is "grant once, keep
  // until changed or revoked," not a forced periodic reauthorization cycle.
  // Absent an explicit choice, the authorization never expires automatically;
  // an owner who wants a shorter window may still request one via `expiresAt`.
  let requestedExpiry: number | null = null;
  if (input.expiresAt) {
    requestedExpiry = Math.floor(Date.parse(input.expiresAt) / 1000);
    if (!Number.isSafeInteger(requestedExpiry) || requestedExpiry <= now) {
      throw new Error("AUTHORIZATION_EXPIRY_INVALID");
    }
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
    expiresAt: requestedExpiry ?? NO_EXPIRY_SENTINEL,
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
    expires_at: requestedExpiry
      ? new Date(requestedExpiry * 1000).toISOString()
      : null,
    draft_expires_at: new Date((now + 10 * 60) * 1000).toISOString(),
    status: "draft",
  });
  if (error) throw error;

  return {
    authorizationId,
    expiresAt: requestedExpiry
      ? new Date(requestedExpiry * 1000).toISOString()
      : null,
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

function authorizationFromRow(
  row: Record<string, unknown>,
): HeadlessAuthorization {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    ownerUserId: String(row.owner_user_id),
    ownerWallet: String(row.owner_wallet),
    policy: authorizationPolicyV1Schema.parse(row.policy),
    policyHash: String(row.policy_hash),
    status: String(row.status),
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
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
    expiresAt: data.expires_at
      ? Math.floor(Date.parse(data.expires_at) / 1000)
      : NO_EXPIRY_SENTINEL,
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
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .maybeSingle();
  if (error) throw error;
  return data
    ? authorizationFromRow(data as unknown as Record<string, unknown>)
    : null;
}

export async function loadOwnerAuthorization(
  agentId: string,
  ownerUserId: string,
) {
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
  return data
    ? authorizationFromRow(data as unknown as Record<string, unknown>)
    : null;
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
  const { error } = await db
    .from("agent_credential_rotation_challenges")
    .insert({
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
      p_secret_hint: clientSecret.slice(-6),
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
  return {
    clientId,
    clientSecret,
    scopes: [
      "agent:read",
      "quests:read",
      "quests:run",
      "quests:decide",
      "quests:cancel",
    ],
  };
}

export async function verifyHeadlessCredential(
  clientId: string,
  clientSecret: string,
) {
  const db = createHeadlessAgentAdminClient();
  const { data, error } = await db
    .from("agent_authorization_credentials")
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  if (!data || (data.expires_at && Date.parse(data.expires_at) <= Date.now()))
    return null;

  const keyring = headlessCredentialPepperKeyring();
  const pepper = keyring.peppers.get(data.pepper_kid);
  if (!pepper) return null;
  const actual = Buffer.from(credentialDigest(clientSecret, pepper), "hex");
  const expected = Buffer.from(data.secret_digest, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return null;

  // The credential authenticates "this client may control Agent X" — live
  // authority comes from whatever authorization is CURRENTLY active for that
  // agent, not from one specific authorization the credential was minted
  // against. A renewal supersedes the old authorization with a new id; a
  // still-active, unrevoked credential must keep working across that.
  const authorization = await loadActiveAuthorization(data.agent_id);
  if (!authorization) return null;
  const agent = await findOwnedAgent(data.agent_id, authorization.ownerUserId);
  if (!agent || agent.status !== "ready") return null;

  await db
    .from("agent_authorization_credentials")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);
  return { credential: data, authorization, agent };
}

/**
 * Whether the credential itself is still live. Deliberately agent-scoped
 * only — the currently active authorization (which may have been renewed
 * since this credential was minted) is checked separately by the caller.
 */
export async function credentialIsActive(
  credentialId: string,
  agentId: string,
): Promise<boolean> {
  const db = createHeadlessAgentAdminClient();
  const { data, error } = await db
    .from("agent_authorization_credentials")
    .select("id")
    .eq("id", credentialId)
    .eq("agent_id", agentId)
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
