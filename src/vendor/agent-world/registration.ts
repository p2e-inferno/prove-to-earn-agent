import {
  decodeAbiParameters,
  createPublicClient,
  http,
  toHex,
  type Address,
} from "viem";
import { worldchain } from "viem/chains";
import { solidityEncode } from "@worldcoin/idkit-core/hashing";

export const AGENTBOOK_APP_ID = "app_a7c3e2b6b83927251a0db5345bd7146a" as const;
export const AGENTBOOK_ACTION = "agentbook-registration";

// The canonical AgentBook deployment. An identical contract exists on Base, but
// the hosted relay only ever sponsors register() on World Chain and
// agentkit-core resolves lookupHuman() there, so reading the nonce anywhere
// else binds the signal to a counter that never advances.
export const AGENTBOOK_CONTRACT =
  "0xA23aB2712eA7BBa896930544C7d6636a96b944dA" as const;

const DEFAULT_RELAY = "https://x402-worldchain.vercel.app";

const agentBookAbi = [
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "getNextNonce",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "lookupHuman",
    outputs: [{ internalType: "uint256", name: "humanId", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

function registrationClient() {
  return createPublicClient({
    chain: worldchain,
    transport: http(process.env.WORLD_CHAIN_RPC_URL),
  });
}

export async function nextAgentBookNonce(address: Address): Promise<bigint> {
  return registrationClient().readContract({
    address: AGENTBOOK_CONTRACT,
    abi: agentBookAbi,
    functionName: "getNextNonce",
    args: [address],
  });
}

export function agentBookSignal(address: Address, nonce: bigint) {
  return solidityEncode(["address", "uint256"], [address, nonce.toString()]);
}

export function normalizeAgentBookProof(raw: string): string[] | null {
  if (raw.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.length === 8 &&
        parsed.every((item) => typeof item === "string")
      ) {
        return parsed;
      }
    } catch {
      return null;
    }
    return null;
  }

  try {
    const decoded = decodeAbiParameters(
      [{ type: "uint256[8]" }],
      raw as `0x${string}`,
    )[0];
    return decoded.map((value) => `0x${value.toString(16).padStart(64, "0")}`);
  } catch {
    return null;
  }
}

export async function submitAgentBookRegistration(input: {
  agent: Address;
  root: string;
  nonce: string;
  nullifierHash: string;
  proof: string[];
}): Promise<{ txHash: string | null }> {
  const relay = (
    process.env.WORLD_AGENTBOOK_RELAY_URL || DEFAULT_RELAY
  ).replace(/\/+$/, "");
  const response = await fetch(`${relay}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, contract: AGENTBOOK_CONTRACT }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(
      `AgentBook relay refused registration (${response.status})`,
    );
  }
  const body = (await response.json().catch(() => null)) as {
    txHash?: unknown;
  } | null;
  return {
    txHash: typeof body?.txHash === "string" ? body.txHash : null,
  };
}

/**
 * Canonical AgentBook lookup. Read directly rather than through
 * createAgentBookVerifier, which returns null for both "not registered" and
 * "could not read" — callers must be able to tell an RPC outage from an
 * unverified agent.
 */
export async function lookupAgentBookHuman(
  address: Address,
): Promise<string | null> {
  const humanId = await registrationClient().readContract({
    address: AGENTBOOK_CONTRACT,
    abi: agentBookAbi,
    functionName: "lookupHuman",
    args: [address],
  });
  return humanId === 0n ? null : toHex(humanId);
}
