/**
 * Type definitions for gasless attestation API
 *
 * These types support the delegated attestation pattern where:
 * - Client encodes data and signs with EAS SDK (user is attester)
 * - Server submits transaction via service wallet (pays gas)
 * - Real attestation UID extracted from on-chain event
 */

/**
 * Generic delegated attestation signature (replaces check-in-specific one)
 * Contains all data needed to submit a delegated attestation on-chain
 */
export interface DelegatedAttestationSignature {
  signature: string; // 0x rsv format
  // JSON-safe: clients typically send these as strings
  deadline: bigint | string;
  attester: string; // user's address (signer)
  recipient: string;
  schemaUid: string;
  data: string; // 0x encoded attestation data
  expirationTime: bigint | string;
  revocable: boolean;
  refUID: string;
  chainId: number;
  network: string;
}

/**
 * Schema field data for encoding
 * Used by client hook to encode attestation data using EAS SchemaEncoder
 */
export interface SchemaFieldData {
  name: string;
  value: any;
  type: "address" | "string" | "uint256" | "bytes32" | "bool" | "uint64";
}

/**
 * API request extension mixin
 * Extend your request types with this to add optional attestation signature
 */
export interface WithAttestationSignature {
  attestationSignature?: DelegatedAttestationSignature | null;
}

/**
 * Result from handleGaslessAttestation helper
 */
export interface GaslessAttestationResult {
  success: boolean;
  uid?: string; // 0x bytes32 attestation UID if successful
  txHash?: string; // Transaction hash if successful
  error?: string; // Error message if failed
  attestationDegraded?: boolean; // True when success is true but attestation itself failed (graceful degradation)
}
