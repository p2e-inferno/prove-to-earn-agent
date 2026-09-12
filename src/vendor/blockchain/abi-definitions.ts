/**
 * Consolidated ABI definitions and contract interfaces
 * Single source of truth for all smart contract ABIs
 */

import { PUBLIC_LOCK_CONTRACT } from "@vendor/blockchain/public-lock-contract";

// ============================================================================
// UNLOCK PROTOCOL ABIS
// ============================================================================

/**
 * Unlock Factory ABI for lock creation.
 *
 * Uses the 3-arg variant so post-init lock setup (add managers, config, transfer
 * fee, renounce) executes atomically in the same tx as `initialize`. The factory
 * acts as the lock's initial manager for the duration of the batch.
 */
export const UNLOCK_FACTORY_ABI = [
  {
    inputs: [
      { internalType: "bytes", name: "data", type: "bytes" },
      { internalType: "uint16", name: "lockVersion", type: "uint16" },
      { internalType: "bytes[]", name: "transactions", type: "bytes[]" },
    ],
    name: "createUpgradeableLockAtVersion",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/**
 * Additional Public Lock ABI functions for extended functionality
 */
export const ADDITIONAL_LOCK_ABI = [
  // Initialize function for lock creation
  {
    inputs: [
      { internalType: "address", name: "_lockCreator", type: "address" },
      { internalType: "uint256", name: "_expirationDuration", type: "uint256" },
      { internalType: "address", name: "_tokenAddress", type: "address" },
      { internalType: "uint256", name: "_keyPrice", type: "uint256" },
      { internalType: "uint256", name: "_maxNumberOfKeys", type: "uint256" },
      { internalType: "string", name: "_lockName", type: "string" },
    ],
    name: "initialize",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Purchase function for buying keys
  {
    inputs: [
      { internalType: "uint256[]", name: "_values", type: "uint256[]" },
      { internalType: "address[]", name: "_recipients", type: "address[]" },
      { internalType: "address[]", name: "_referrers", type: "address[]" },
      { internalType: "address[]", name: "_keyManagers", type: "address[]" },
      { internalType: "bytes[]", name: "_data", type: "bytes[]" },
    ],
    name: "purchase",
    outputs: [
      { internalType: "uint256[]", name: "tokenIds", type: "uint256[]" },
    ],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "_recipient", type: "address" },
      { internalType: "address", name: "_referrer", type: "address" },
      { internalType: "bytes", name: "_data", type: "bytes" },
    ],
    name: "purchasePriceFor",
    outputs: [
      { internalType: "uint256", name: "minKeyPrice", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  // Lock management functions
  {
    inputs: [{ internalType: "address", name: "_account", type: "address" }],
    name: "addLockManager",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_account", type: "address" }],
    name: "isLockManager",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "ownerOf",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_owner", type: "address" }],
    name: "totalKeys",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  // Token address function to check what token the lock uses
  {
    inputs: [],
    name: "tokenAddress",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  // Renounce lock manager function
  {
    inputs: [],
    name: "renounceLockManager",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/**
 * ABI for Subscription Renewal, Trials, and Refund operations
 */
export const RENEWAL_LOCK_ABI = [
  // Paid extensions
  {
    inputs: [
      { internalType: "uint256", name: "_value", type: "uint256" },
      { internalType: "uint256", name: "_tokenId", type: "uint256" },
      { internalType: "address", name: "_referrer", type: "address" },
      { internalType: "bytes", name: "_data", type: "bytes" },
    ],
    name: "extend",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_tokenId", type: "uint256" },
      { internalType: "uint256", name: "_duration", type: "uint256" },
    ],
    name: "grantKeyExtension",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Membership renewal
  {
    inputs: [
      { internalType: "uint256", name: "_tokenId", type: "uint256" },
      { internalType: "address", name: "_referrer", type: "address" },
    ],
    name: "renewMembershipFor",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_tokenId", type: "uint256" },
      { internalType: "address", name: "_referrer", type: "address" },
    ],
    name: "isRenewable",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  // Trial & refund configuration
  {
    inputs: [],
    name: "freeTrialLength",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_freeTrialLength", type: "uint256" },
      {
        internalType: "uint256",
        name: "_refundPenaltyBasisPoints",
        type: "uint256",
      },
    ],
    name: "updateRefundPenalty",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Refund security functions
  {
    inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
    name: "getCancelAndRefundValue",
    outputs: [{ internalType: "uint256", name: "refund", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
    name: "cancelAndRefund",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/**
 * ABI for Lock Configuration and Management operations
 */
export const LOCK_CONFIG_ABI = [
  // View configuration
  {
    inputs: [],
    name: "expirationDuration",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  // Core configuration updates
  {
    inputs: [
      {
        internalType: "uint256",
        name: "_newExpirationDuration",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "_maxNumberOfKeys",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "_maxKeysPerAcccount",
        type: "uint256",
      },
    ],
    name: "updateLockConfig",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_keyPrice", type: "uint256" },
      { internalType: "address", name: "_tokenAddress", type: "address" },
    ],
    name: "updateKeyPricing",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "uint256",
        name: "_transferFeeBasisPoints",
        type: "uint256",
      },
    ],
    name: "updateTransferFee",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Metadata and identity
  {
    inputs: [
      { internalType: "string", name: "_lockName", type: "string" },
      { internalType: "string", name: "_lockSymbol", type: "string" },
      { internalType: "string", name: "_baseTokenURI", type: "string" },
    ],
    name: "setLockMetadata",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "setOwner",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Event hooks configuration
  {
    inputs: [
      {
        internalType: "address",
        name: "_onKeyPurchaseHook",
        type: "address",
      },
      {
        internalType: "address",
        name: "_onKeyCancelHook",
        type: "address",
      },
      {
        internalType: "address",
        name: "_onValidKeyHook",
        type: "address",
      },
      {
        internalType: "address",
        name: "_onTokenURIHook",
        type: "address",
      },
      {
        internalType: "address",
        name: "_onKeyTransferHook",
        type: "address",
      },
      {
        internalType: "address",
        name: "_onKeyExtendHook",
        type: "address",
      },
      {
        internalType: "address",
        name: "_onKeyGrantHook",
        type: "address",
      },
      {
        internalType: "address",
        name: "_onHasRoleHook",
        type: "address",
      },
    ],
    name: "setEventHooks",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Gas refund and referrer configuration
  {
    inputs: [
      { internalType: "uint256", name: "_refundValue", type: "uint256" },
    ],
    name: "setGasRefundValue",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "_referrer", type: "address" },
      { internalType: "uint256", name: "_feeBasisPoint", type: "uint256" },
    ],
    name: "setReferrerFee",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Individual key management
  {
    inputs: [
      { internalType: "uint256", name: "_tokenId", type: "uint256" },
      { internalType: "uint256", name: "_newExpiration", type: "uint256" },
    ],
    name: "setKeyExpiration",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_tokenId", type: "uint256" },
      { internalType: "address", name: "_keyManager", type: "address" },
    ],
    name: "setKeyManagerOf",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/**
 * Complete Public Lock ABI combining base, additional, renewal, and config functions
 */
/**
 * Zero-argument PublicLock custom errors. Without these viem cannot name a
 * revert, so walletErrors' Unlock messages ("This pass is sold out.") can never
 * match and every failure degrades to a raw revert string.
 */
export const LOCK_ERROR_ABI = [
  "LOCK_HAS_CHANGED",
  "LOCK_SOLD_OUT",
  "NOT_ENOUGH_FUNDS",
  "NOT_ENOUGH_ALLOWANCE",
  "OUT_OF_RANGE",
  "ONLY_LOCK_MANAGER",
  "TRANSFER_FAILED",
  "MAX_KEYS_REACHED",
  "MAX_KEYS",
  "OWNS_KEY",
  "KEY_NOT_VALID",
  "INSUFFICIENT_VALUE",
  "PURCHASE_BLOCKED_BY_HOOK",
  "CANT_EXTEND_NON_EXPIRING_KEY",
  "OWNER_CANT_BE_ADDRESS_ZERO",
].map((name) => ({ inputs: [], name, type: "error" as const }));

export const COMPLETE_LOCK_ABI = [
  ...PUBLIC_LOCK_CONTRACT.abi,
  ...ADDITIONAL_LOCK_ABI,
  ...RENEWAL_LOCK_ABI,
  ...LOCK_CONFIG_ABI,
  ...LOCK_ERROR_ABI,
];

// ============================================================================
// ERC20 ABIS
// ============================================================================

/**
 * Standard ERC20 ABI functions needed for token operations
 */
export const ERC20_ABI = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "name",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "spender", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "address", name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  // OZ v5 custom errors, included so viem can decode transfer reverts.
  {
    inputs: [
      { internalType: "address", name: "sender", type: "address" },
      { internalType: "uint256", name: "balance", type: "uint256" },
      { internalType: "uint256", name: "needed", type: "uint256" },
    ],
    name: "ERC20InsufficientBalance",
    type: "error",
  },
  {
    inputs: [{ internalType: "address", name: "receiver", type: "address" }],
    name: "ERC20InvalidReceiver",
    type: "error",
  },
  {
    inputs: [{ internalType: "address", name: "sender", type: "address" }],
    name: "ERC20InvalidSender",
    type: "error",
  },
] as const;

// ============================================================================
// EVENT SIGNATURES
// ============================================================================

/**
 * Common event signatures for log parsing
 */
export const EVENT_SIGNATURES = {
  TRANSFER:
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  NEW_LOCK:
    "0x01017ed19df0c7f8acc436147b234b09664a9fb4797b4fa3fb9e599c2eb67be7",
  APPROVAL:
    "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
} as const;

/**
 * Unlock Factory event interfaces for log parsing
 */
export const UNLOCK_FACTORY_EVENTS = [
  "event NewLock(address indexed lockOwner, address indexed newLockAddress)",
] as const;

/**
 * Lock payment-related event ABI fragments used by crypto purchase receipt
 * verification and reconciliation.
 *
 * PaymentReceipt has no indexed parameters; eth_getLogs can filter only by
 * `address` and `topics[0]`. PublicLock V11–V14 emit no PaymentReceipt for
 * extend/renew (only KeyExtended); PaymentReceipt was added in V15.
 */
export const LOCK_PAYMENT_EVENTS = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: "uint256[]",
        name: "tokenIds",
        type: "uint256[]",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "purchases",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "extensions",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "address",
        name: "payer",
        type: "address",
      },
      {
        indexed: false,
        internalType: "address",
        name: "tokenAddress",
        type: "address",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "totalPaid",
        type: "uint256",
      },
    ],
    name: "PaymentReceipt",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
      {
        indexed: true,
        internalType: "uint256",
        name: "tokenId",
        type: "uint256",
      },
    ],
    name: "Transfer",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "uint256",
        name: "tokenId",
        type: "uint256",
      },
      {
        indexed: false,
        internalType: "uint256",
        name: "newTimestamp",
        type: "uint256",
      },
    ],
    name: "KeyExtended",
    type: "event",
  },
] as const;

/**
 * ERC20 Transfer event (2 indexed topics; distinguishable from ERC721 by
 * topic count when decoding receipt logs).
 */
export const ERC20_TRANSFER_EVENT = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
      {
        indexed: false,
        internalType: "uint256",
        name: "value",
        type: "uint256",
      },
    ],
    name: "Transfer",
    type: "event",
  },
] as const;

// ============================================================================
// CONTRACT ADDRESSES
// ============================================================================

/**
 * Unlock Protocol factory contract addresses by chain ID
 */
export const UNLOCK_FACTORY_ADDRESSES = {
  8453: "0xd0b14797b9D08493392865647384974470202A78", // Base mainnet
  84532: "0x259813B665C8f6074391028ef782e27B65840d89", // Base Sepolia testnet
} as const;

// ============================================================================
// ABI UTILITIES
// ============================================================================

/**
 * Get the appropriate ABI for a given contract type
 */
export const getContractABI = (contractType: "lock" | "factory" | "erc20") => {
  switch (contractType) {
    case "lock":
      return COMPLETE_LOCK_ABI;
    case "factory":
      return UNLOCK_FACTORY_ABI;
    case "erc20":
      return ERC20_ABI;
    default:
      throw new Error(`Unknown contract type: ${contractType}`);
  }
};

/**
 * Check if an address is a valid Ethereum address
 */
export const isValidAddress = (address: string): boolean => {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
};

/**
 * Check if an address is the zero address
 */
export const isZeroAddress = (address: string): boolean => {
  return address === "0x0000000000000000000000000000000000000000";
};

// ============================================================================
// LOCK CONFIGURATION HELPERS
// ============================================================================

/**
 * Helper to create updateLockConfig parameters for securing grant-based locks
 * Sets maxNumberOfKeys to 0 to disable purchases
 *
 * @param expirationDuration - Current or new expiration duration in seconds
 * @param maxNumberOfKeys - Current or new max total keys
 * @param maxKeysPerAddress - Per-address cap (must be >= 1 for some lock versions)
 * @returns Parameters ready for updateLockConfig contract call
 *
 * @example
 * // Secure an existing milestone lock
 * const params = createSecureLockConfigParams(
 *   365 * 24 * 60 * 60, // 1 year
 *   0,                  // disable purchases
 *   1                   // per-address cap
 * );
 * await lockContract.updateLockConfig(...params);
 */
export const createSecureLockConfigParams = (
  expirationDuration: number | bigint,
  maxNumberOfKeys: number | bigint,
  maxKeysPerAddress: number | bigint = 1,
): [bigint, bigint, bigint] => {
  return [
    BigInt(expirationDuration),
    BigInt(maxNumberOfKeys),
    BigInt(maxKeysPerAddress),
  ];
};

/**
 * View functions to read current lock configuration
 * Use these to query existing values before updating
 */
export const LOCK_CONFIG_VIEW_ABI = [
  {
    inputs: [],
    name: "expirationDuration",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "maxNumberOfKeys",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "maxKeysPerAddress",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * View function to read current transfer fee basis points.
 *
 * `10000` means transfers are effectively disabled (non-transferable).
 */
export const TRANSFER_FEE_VIEW_ABI = [
  {
    inputs: [],
    name: "transferFeeBasisPoints",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
