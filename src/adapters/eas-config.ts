/**
 * EAS Configuration for P2E Inferno
 * Using Base Sepolia testnet (same as Teerex)
 */

export const EAS_CONFIG = {
  // Base Sepolia EAS contract addresses
  CONTRACT_ADDRESS: "0x4200000000000000000000000000000000000021",
  SCHEMA_REGISTRY_ADDRESS: "0x4200000000000000000000000000000000000020",
  NETWORK: "base-sepolia",
  CHAIN_ID: 84532,
} as const;

// EAS Contract ABI - Core functions needed for attestations
export const EAS_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: "bytes32", name: "schema", type: "bytes32" },
          { internalType: "address", name: "recipient", type: "address" },
          { internalType: "uint64", name: "expirationTime", type: "uint64" },
          { internalType: "bool", name: "revocable", type: "bool" },
          { internalType: "bytes32", name: "refUID", type: "bytes32" },
          { internalType: "bytes", name: "data", type: "bytes" },
        ],
        internalType: "struct AttestationRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "attest",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          { internalType: "bytes32", name: "schema", type: "bytes32" },
          { internalType: "bytes32", name: "uid", type: "bytes32" },
        ],
        internalType: "struct RevocationRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "revoke",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "payable",
    type: "function",
  },
] as const;

// Schema Registry ABI - For registering new schemas
// Schema Registry ABI (from EAS contracts) - For registering new schemas
export const SCHEMA_REGISTRY_ABI = [
  {
    inputs: [
      { internalType: "string", name: "schema", type: "string" },
      {
        internalType: "contract ISchemaResolver",
        name: "resolver",
        type: "address",
      },
      { internalType: "bool", name: "revocable", type: "bool" },
    ],
    name: "register",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// Schema Registry read ABI (from EAS contracts)
export const SCHEMA_REGISTRY_READ_ABI = [
  {
    inputs: [{ internalType: "bytes32", name: "uid", type: "bytes32" }],
    name: "getSchema",
    outputs: [
      {
        components: [
          { internalType: "bytes32", name: "uid", type: "bytes32" },
          {
            internalType: "contract ISchemaResolver",
            name: "resolver",
            type: "address",
          },
          { internalType: "bool", name: "revocable", type: "bool" },
          { internalType: "string", name: "schema", type: "string" },
        ],
        internalType: "struct SchemaRecord",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Schema Registry event ABI (from EAS contracts)
export const SCHEMA_REGISTRY_REGISTERED_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "uid", type: "bytes32" },
      {
        indexed: true,
        internalType: "address",
        name: "registerer",
        type: "address",
      },
      {
        components: [
          { internalType: "bytes32", name: "uid", type: "bytes32" },
          {
            internalType: "contract ISchemaResolver",
            name: "resolver",
            type: "address",
          },
          { internalType: "bool", name: "revocable", type: "bool" },
          { internalType: "string", name: "schema", type: "string" },
        ],
        indexed: false,
        internalType: "struct SchemaRecord",
        name: "schema",
        type: "tuple",
      },
    ],
    name: "Registered",
    type: "event",
  },
] as const;

// Schema UIDs for P2E Inferno specific attestations
// Only use NEXT_PUBLIC environment variables (accessible in both client and server)
// No hardcoded fallbacks - explicit configuration required
export const P2E_SCHEMA_UIDS = {
  DAILY_CHECKIN: process.env.NEXT_PUBLIC_DAILY_CHECKIN_SCHEMA_UID || null,
  QUEST_COMPLETION: process.env.NEXT_PUBLIC_QUEST_COMPLETION_SCHEMA_UID || null,
  BOOTCAMP_COMPLETION:
    process.env.NEXT_PUBLIC_BOOTCAMP_COMPLETION_SCHEMA_UID || null,
  MILESTONE_ACHIEVEMENT:
    process.env.NEXT_PUBLIC_MILESTONE_ACHIEVEMENT_SCHEMA_UID || null,
  XP_RENEWAL: process.env.NEXT_PUBLIC_XP_RENEWAL_SCHEMA_UID || null,
  DG_WITHDRAWAL: process.env.NEXT_PUBLIC_DG_WITHDRAWAL_SCHEMA_UID || null,
  DG_CONFIG_CHANGE: process.env.NEXT_PUBLIC_DG_CONFIG_CHANGE_SCHEMA_UID || null,
  MILESTONE_TASK_REWARD_CLAIM:
    process.env.NEXT_PUBLIC_MILESTONE_TASK_REWARD_CLAIM_SCHEMA_UID || null,
  QUEST_TASK_REWARD_CLAIM:
    process.env.NEXT_PUBLIC_QUEST_TASK_REWARD_CLAIM_SCHEMA_UID || null,
} as const;

// Helper function to get schema UID with validation and clear error messages
export function requireSchemaUID(type: keyof typeof P2E_SCHEMA_UIDS): string {
  const uid = P2E_SCHEMA_UIDS[type];

  if (!uid) {
    throw new Error(
      `Schema UID not configured for ${type}. ` +
        `Please set NEXT_PUBLIC_${type}_SCHEMA_UID environment variable.`,
    );
  }

  // Only validate format when EAS is enabled
  const isEasEnabled = process.env.NEXT_PUBLIC_ENABLE_EAS === "true";
  if (isEasEnabled && !/^0x[0-9a-fA-F]{64}$/.test(uid)) {
    throw new Error(
      `Invalid schema UID format for ${type}. ` +
        `When EAS is enabled, schema UID must be 64-character hex string starting with 0x. ` +
        `Got: ${uid}. Either disable EAS or provide valid schema UID.`,
    );
  }

  return uid;
}

export type SchemaKey =
  | "daily_checkin"
  | "quest_completion"
  | "bootcamp_completion"
  | "milestone_achievement"
  | "xp_renewal"
  | "dg_withdrawal"
  | "dg_config_change"
  | "milestone_task_reward_claim"
  | "quest_task_reward_claim";

const schemaKeyEnvMap: Record<SchemaKey, keyof typeof P2E_SCHEMA_UIDS> = {
  daily_checkin: "DAILY_CHECKIN",
  quest_completion: "QUEST_COMPLETION",
  bootcamp_completion: "BOOTCAMP_COMPLETION",
  milestone_achievement: "MILESTONE_ACHIEVEMENT",
  xp_renewal: "XP_RENEWAL",
  dg_withdrawal: "DG_WITHDRAWAL",
  dg_config_change: "DG_CONFIG_CHANGE",
  milestone_task_reward_claim: "MILESTONE_TASK_REWARD_CLAIM",
  quest_task_reward_claim: "QUEST_TASK_REWARD_CLAIM",
};

export function resolveSchemaUIDFromEnv(schemaKey: SchemaKey): string | null {
  const envKey = schemaKeyEnvMap[schemaKey];
  return envKey ? P2E_SCHEMA_UIDS[envKey] : null;
}

// Helper function to check if EAS is enabled
export function isEASEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ENABLE_EAS === "true";
}
