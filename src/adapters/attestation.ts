/**
 * Attestation adapter — EAS (Ethereum Attestation Service) configuration and
 * schema resolution.
 *
 * EAS itself is public infrastructure, so `eas-config.ts` (vendored
 * verbatim) and this module are real working code, not a fixture — unlike
 * the quest/identity/membership adapters. Two simplifications relative to
 * the private platform's `lib/attestation/core/network-config.ts` and
 * `lib/attestation/schemas/network-resolver.ts`:
 *
 * - Network config is a static fallback table (Base + Base Sepolia's public
 *   EAS deployment addresses — the same address on every OP-stack chain)
 *   instead of the private platform's DB-backed `eas_networks` table. A host
 *   that needs DB-backed per-network overrides can call
 *   `configureNetworkConfig(...)`.
 * - `resolveSchemaUID` reads only `NEXT_PUBLIC_*_SCHEMA_UID` env vars,
 *   dropping the private platform's `attestation_schemas` DB lookup (an
 *   admin-managed schema registry that is out of scope here).
 */
import {
  EAS_CONFIG,
  EAS_ABI,
  SCHEMA_REGISTRY_ABI,
  resolveSchemaUIDFromEnv,
  isEASEnabled,
  type SchemaKey,
} from "./eas-config";

export { EAS_CONFIG, EAS_ABI, SCHEMA_REGISTRY_ABI, isEASEnabled };
export type { SchemaKey };
export type { DelegatedAttestationSignature } from "./attestation-types";

export type EasNetworkConfig = {
  name: string;
  chainId: number;
  displayName: string;
  isTestnet: boolean;
  enabled: boolean;
  easContractAddress: string;
  schemaRegistryAddress: string;
  eip712ProxyAddress: string | null;
  easScanBaseUrl: string | null;
  explorerBaseUrl: string | null;
  rpcUrl: string | null;
};

const STATIC_NETWORKS: Record<string, EasNetworkConfig> = {
  "base-sepolia": {
    name: "base-sepolia",
    chainId: 84532,
    displayName: "Base Sepolia",
    isTestnet: true,
    enabled: true,
    easContractAddress: "0x4200000000000000000000000000000000000021",
    schemaRegistryAddress: "0x4200000000000000000000000000000000000020",
    eip712ProxyAddress: null,
    easScanBaseUrl: "https://base-sepolia.easscan.org",
    explorerBaseUrl: "https://sepolia.basescan.org",
    rpcUrl: null,
  },
  base: {
    name: "base",
    chainId: 8453,
    displayName: "Base",
    isTestnet: false,
    enabled: true,
    easContractAddress: "0x4200000000000000000000000000000000000021",
    schemaRegistryAddress: "0x4200000000000000000000000000000000000020",
    eip712ProxyAddress: null,
    easScanBaseUrl: "https://base.easscan.org",
    explorerBaseUrl: "https://basescan.org",
    rpcUrl: null,
  },
};

let networkTable: Record<string, EasNetworkConfig> = STATIC_NETWORKS;

/** Override with DB-backed or otherwise dynamic network config. */
export function configureNetworkConfig(table: Record<string, EasNetworkConfig>): void {
  networkTable = table;
}

export function getDefaultNetworkName(): string {
  return EAS_CONFIG.NETWORK;
}

export async function getNetworkConfig(name?: string): Promise<EasNetworkConfig | null> {
  return networkTable[name ?? getDefaultNetworkName()] ?? null;
}

export async function resolveNetworkConfig(name?: string): Promise<EasNetworkConfig> {
  const config = await getNetworkConfig(name);
  if (!config) {
    throw new Error(`Unknown EAS network: ${name ?? getDefaultNetworkName()}`);
  }
  return config;
}

export async function buildEasScanLink(
  uid: string,
  networkName?: string,
): Promise<string | null> {
  if (!uid) return null;
  const network = await resolveNetworkConfig(networkName);
  const base = network.easScanBaseUrl?.replace(/\/+$/, "") ?? "";
  return base ? `${base}/attestation/view/${uid}` : null;
}

export type SchemaUIDResolver = (
  schemaKey: SchemaKey,
  network?: string,
) => Promise<string | null>;

let schemaResolver: SchemaUIDResolver = async (schemaKey) =>
  resolveSchemaUIDFromEnv(schemaKey);

/** Override with a DB-backed schema registry lookup. */
export function configureSchemaResolver(resolver: SchemaUIDResolver): void {
  schemaResolver = resolver;
}

export const resolveSchemaUID: SchemaUIDResolver = (schemaKey, network) =>
  schemaResolver(schemaKey, network);
