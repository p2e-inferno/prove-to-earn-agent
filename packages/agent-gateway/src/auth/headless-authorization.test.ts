/**
 * @jest-environment node
 */
// jest.config.js remaps "ethers" to a trivial global stub for every test
// (unrelated to this suite — EAS/attestation tests depend on that shape), so
// jest.unmock can't restore the real library here. This suite isn't about
// ethers' cryptography, which is a trusted external dependency; it's about
// our own nullable-expiry branching, so a small local double that records
// what it was called with is the right level of fidelity.
let verifyTypedDataCalls: Array<{ message: Record<string, unknown> }> = [];
jest.mock("ethers", () => ({
  ethers: {
    toUtf8Bytes: (value: string) => Buffer.from(value, "utf8"),
    keccak256: () => `0x${"1".repeat(64)}`,
    getAddress: (address: string) => address,
    verifyTypedData: (
      _domain: unknown,
      _types: unknown,
      message: Record<string, unknown>,
      signature: string,
    ) => {
      verifyTypedDataCalls.push({ message });
      const match = /^signed-by:(0x[0-9a-fA-F]{40})$/.exec(signature);
      if (!match) throw new Error("bad test signature");
      return match[1];
    },
  },
}));

jest.mock("@/lib/supabase/headless-agent-schema", () => ({
  createHeadlessAgentAdminClient: jest.fn(),
}));
jest.mock("../db/agents", () => ({
  findOwnedAgent: jest.fn(),
  loadPermissions: jest.fn(),
  hasCapability: (
    permissions: Array<{
      capability: string;
      dailyQuestTemplateId: string | null;
    }>,
    capability: string,
    templateId?: string | null,
  ) =>
    permissions.some(
      (permission) =>
        permission.capability === capability &&
        (permission.dailyQuestTemplateId === null ||
          (Boolean(templateId) &&
            permission.dailyQuestTemplateId === templateId)),
    ),
}));

import { createHeadlessAgentAdminClient } from "@/lib/supabase/headless-agent-schema";
import { authorizationPolicyV1Schema } from "@p2e/agent-contracts";
import { findOwnedAgent, loadPermissions } from "../db/agents";
import type { AgentPermission } from "../db/agents";
import {
  activateAuthorization,
  createAuthorizationDraft,
  hasLiveDailyQuestPermission,
  headlessPolicyAllowsTemplate,
  loadActiveAuthorization,
} from "./headless-authorization";
import { AGENT_CHAIN_ID } from "../env";

const mockFindOwnedAgent = findOwnedAgent as jest.Mock;
const mockLoadPermissions = loadPermissions as jest.Mock;
const mockCreateClient = createHeadlessAgentAdminClient as jest.Mock;

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const OWNER_USER_ID = "did:privy:test-owner";
const OWNER_WALLET = "0x2222222222222222222222222222222222222222";
const AGENT_WALLET = "0x3333333333333333333333333333333333333333";
const REWARD_WALLET = "0x4444444444444444444444444444444444444444";
const TEMPLATE_ID = "55555555-5555-5555-5555-555555555555";

/** Owner-decision fields only; createAuthorizationDraft fills in the rest
 * via normalizePolicyInput. */
function validPolicy() {
  return {
    templateIds: [TEMPLATE_ID],
    actions: [{ actionId: "p2e_daily_checkin", version: 1 }],
    assetLimits: [
      {
        asset: "ETH",
        tokenAddress: null,
        perActionRaw: "1",
        perRunRaw: "2",
        rolling24hRaw: "3",
      },
    ],
  };
}

/** A complete, already-normalized policy — for reading a row back directly,
 * bypassing normalizePolicyInput. */
function fullPolicy() {
  return {
    ...validPolicy(),
    version: 1 as const,
    chain: `eip155:${AGENT_CHAIN_ID}`,
    resource: "https://p2einferno.example/agents",
    maxGasPerActionRaw: "1",
    maxGasPerRunRaw: "2",
    maxGasRolling24hRaw: "3",
    maxX402PerRequestRaw: "1",
    maxX402PerRunRaw: "2",
    maxX402Rolling24hRaw: "3",
    maxServiceFeePerActionRaw: "1",
    maxServiceFeePerRunRaw: "2",
    maxServiceFeeRolling24hRaw: "3",
    minNativeReserveRaw: "1",
    maxFundingSwapsPerRun: 1,
    maxSlippageBps: 100,
  };
}

/** Minimal chainable query-builder stand-in: every non-terminal call returns
 * itself, and the configured terminal resolves the awaited result. */
function chain(terminal: Record<string, unknown>) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    or: () => builder,
    maybeSingle: () => Promise.resolve(terminal),
  };
  return builder;
}

beforeEach(() => {
  jest.clearAllMocks();
  verifyTypedDataCalls = [];
  mockFindOwnedAgent.mockResolvedValue({
    id: AGENT_ID,
    ownerUserId: OWNER_USER_ID,
    agentWallet: AGENT_WALLET,
    rewardWallet: REWARD_WALLET,
    status: "ready",
  });
  mockLoadPermissions.mockResolvedValue(
    [
      "quests.read",
      "quests.start",
      "tasks.complete",
      "tasks.claim",
      "quests.complete",
    ].map((capability) => ({ capability, dailyQuestTemplateId: null })),
  );
});

describe("live daily-quest permission bounds", () => {
  const capabilities: AgentPermission["capability"][] = [
    "quests.read",
    "quests.start",
    "tasks.complete",
    "tasks.claim",
    "quests.complete",
  ];
  const allFor = (templateId: string | null): AgentPermission[] =>
    capabilities.map((capability) => ({
      capability,
      dailyQuestTemplateId: templateId,
    }));

  it("requires every live capability and lets a headless policy only narrow it", () => {
    const templateA = TEMPLATE_ID;
    const templateB = "66666666-6666-6666-6666-666666666666";
    const permissions = [...allFor(templateA), ...allFor(templateB)].filter(
      (permission) =>
        !(
          permission.capability === "tasks.claim" &&
          permission.dailyQuestTemplateId === templateB
        ),
    );

    expect(hasLiveDailyQuestPermission(permissions, templateA)).toBe(true);
    expect(hasLiveDailyQuestPermission(permissions, templateB)).toBe(false);
    const policy = authorizationPolicyV1Schema.parse(fullPolicy());
    expect(headlessPolicyAllowsTemplate(policy, templateA)).toBe(true);
    expect(headlessPolicyAllowsTemplate(policy, templateB)).toBe(false);
  });
});

describe("createAuthorizationDraft: nullable expiry", () => {
  it("does not require duplicate template or action scope input", async () => {
    mockCreateClient.mockReturnValue({
      from: () => ({ insert: () => Promise.resolve({ error: null }) }),
    });

    const result = await createAuthorizationDraft({
      agentId: AGENT_ID,
      ownerUserId: OWNER_USER_ID,
      ownerWallet: OWNER_WALLET,
      policy: { assetLimits: validPolicy().assetLimits },
    });

    expect(result.policy.templateIds).toEqual([]);
    expect(result.policy.actions).toEqual([]);
  });

  it("defaults to no expiry (NULL), signed with the 0 sentinel", async () => {
    const inserted: Record<string, unknown>[] = [];
    mockCreateClient.mockReturnValue({
      from: () => ({
        insert: (payload: Record<string, unknown>) => {
          inserted.push(payload);
          return Promise.resolve({ error: null });
        },
      }),
    });

    const result = await createAuthorizationDraft({
      agentId: AGENT_ID,
      ownerUserId: OWNER_USER_ID,
      ownerWallet: OWNER_WALLET,
      policy: validPolicy(),
    });

    expect(result.expiresAt).toBeNull();
    expect(result.typedData.message.expiresAt).toBe(0);
    expect(inserted[0]?.expires_at).toBeNull();
  });

  it("honors an explicit finite expiry", async () => {
    const inserted: Record<string, unknown>[] = [];
    mockCreateClient.mockReturnValue({
      from: () => ({
        insert: (payload: Record<string, unknown>) => {
          inserted.push(payload);
          return Promise.resolve({ error: null });
        },
      }),
    });

    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = await createAuthorizationDraft({
      agentId: AGENT_ID,
      ownerUserId: OWNER_USER_ID,
      ownerWallet: OWNER_WALLET,
      policy: validPolicy(),
      expiresAt: futureIso,
    });

    expect(result.expiresAt).toBe(
      new Date(Math.floor(Date.parse(futureIso) / 1000) * 1000).toISOString(),
    );
    expect(result.typedData.message.expiresAt).toBeGreaterThan(0);
    expect(inserted[0]?.expires_at).toBe(result.expiresAt);
  });

  it("rejects a requested expiry that has already passed", async () => {
    mockCreateClient.mockReturnValue({ from: () => ({ insert: jest.fn() }) });

    await expect(
      createAuthorizationDraft({
        agentId: AGENT_ID,
        ownerUserId: OWNER_USER_ID,
        ownerWallet: OWNER_WALLET,
        policy: validPolicy(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ).rejects.toThrow("AUTHORIZATION_EXPIRY_INVALID");
  });
});

describe("loadActiveAuthorization: nullable expiry", () => {
  it("treats a NULL expires_at row as never expiring", async () => {
    mockCreateClient.mockReturnValue({
      from: () =>
        chain({
          data: {
            id: AGENT_ID,
            agent_id: AGENT_ID,
            owner_user_id: OWNER_USER_ID,
            owner_wallet: OWNER_WALLET,
            policy: fullPolicy(),
            policy_hash: `0x${"a".repeat(64)}`,
            status: "active",
            expires_at: null,
            activated_at: null,
          },
          error: null,
        }),
    });

    const authorization = await loadActiveAuthorization(AGENT_ID);
    expect(authorization?.expiresAt).toBeNull();
  });
});

describe("activateAuthorization: nullable expiry sentinel", () => {
  it("reconstructs the 0 sentinel (not a crash or a bogus expiry) for a NULL row and activates it", async () => {
    const authorizationId = "66666666-6666-6666-6666-666666666666";
    const policyHash = `0x${"b".repeat(64)}`;
    const nonce = `0x${"c".repeat(64)}`;
    const issuedAt = Math.floor(Date.now() / 1000) - 60;
    const ownerWallet = OWNER_WALLET;

    const rpcCalls: unknown[] = [];
    mockCreateClient.mockReturnValue({
      from: () =>
        chain({
          data: {
            id: authorizationId,
            agent_id: AGENT_ID,
            owner_user_id: OWNER_USER_ID,
            owner_wallet: ownerWallet.toLowerCase(),
            agent_wallet: AGENT_WALLET,
            reward_wallet: REWARD_WALLET,
            chain_id: AGENT_CHAIN_ID,
            resource: "https://p2einferno.example/agents",
            policy_hash: policyHash,
            nonce,
            issued_at: new Date(issuedAt * 1000).toISOString(),
            expires_at: null,
          },
          error: null,
        }),
      rpc: (name: string, args: unknown) => {
        rpcCalls.push({ name, args });
        return Promise.resolve({
          data: { outcome: "active", authorization_id: authorizationId },
          error: null,
        });
      },
    });

    const result = await activateAuthorization({
      authorizationId,
      agentId: AGENT_ID,
      ownerUserId: OWNER_USER_ID,
      ownerWallet,
      signature: `signed-by:${ownerWallet}`,
    });

    expect(verifyTypedDataCalls).toHaveLength(1);
    expect(verifyTypedDataCalls[0]?.message.expiresAt).toBe(0);
    expect(result).toEqual({
      outcome: "active",
      authorization_id: authorizationId,
    });
    expect(rpcCalls).toHaveLength(1);
  });
});
