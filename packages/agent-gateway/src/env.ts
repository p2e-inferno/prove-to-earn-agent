export const AGENT_SESSION_ISSUER = "p2einferno";
export const AGENT_SESSION_AUDIENCE = "agent";
export const AGENT_SESSION_TTL_SECONDS = 900;
export const AGENT_CHALLENGE_TTL_SECONDS = 300;
export const AGENT_GRANT_TTL_SECONDS = 900;

/** Base mainnet: the chain the Uniswap verifier and x402 settlement share. */
export const AGENT_CHAIN_ID = 8453;
export const AGENT_NETWORK = "eip155:8453" as const;

export function agentSessionSecret(): Uint8Array {
  const secret = process.env.AGENT_SESSION_JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV !== "development") {
      throw new Error(
        "AGENT_SESSION_JWT_SECRET is required outside development",
      );
    }
    return new TextEncoder().encode("dev-only-agent-session-secret");
  }
  return new TextEncoder().encode(secret);
}

export function agentAudienceOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") ||
    "http://localhost:3000"
  );
}

export function x402PayToAddress(): string {
  const payTo = process.env.X402_PAY_TO_ADDRESS;
  if (!payTo) {
    throw new Error("X402_PAY_TO_ADDRESS is required to price agent routes");
  }
  return payTo;
}

const PUBLIC_TESTNET_FACILITATOR = "https://x402.org/facilitator";

/**
 * The public x402.org facilitator is testnet-oriented, and this gateway settles
 * on Base mainnet. Defaulting to it in production would take real payments to a
 * facilitator that cannot settle them, so that combination fails closed.
 */
export function x402FacilitatorUrl(): string {
  const configured = process.env.X402_FACILITATOR_URL?.trim();
  if (configured) return configured;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Set CDP_API_KEY_ID/CDP_API_KEY_SECRET, or X402_FACILITATOR_URL, to a Base mainnet-capable facilitator in production",
    );
  }
  return PUBLIC_TESTNET_FACILITATOR;
}

/** CDP credentials present means the hosted facilitator can settle on mainnet. */
export function cdpFacilitatorConfigured(): boolean {
  return Boolean(
    process.env.CDP_API_KEY_ID?.trim() &&
    process.env.CDP_API_KEY_SECRET?.trim(),
  );
}

export function worldChainRpcUrl(): string | undefined {
  return process.env.WORLD_CHAIN_RPC_URL;
}

export function agentOwnerLimit(): number {
  const raw = Number(process.env.AGENT_MAX_NON_REVOKED_PER_OWNER || 1);
  return Number.isSafeInteger(raw) && raw > 0 && raw <= 100 ? raw : 1;
}

export function agentkitDiscountPercent(): number {
  const raw = Number(process.env.AGENTKIT_DISCOUNT_PERCENT || 50);
  return Number.isInteger(raw) && raw > 0 && raw < 100 ? raw : 50;
}

export function agentkitDiscountUses(): number {
  const raw = Number(process.env.AGENTKIT_DISCOUNT_USES || 100);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 100;
}
