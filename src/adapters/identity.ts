/**
 * Identity adapter — owner authentication and wallet binding.
 *
 * `getUserWalletAddresses` is a real, working implementation against Privy's
 * server SDK (`@privy-io/server-auth`) — Privy is a third-party auth
 * provider, not private platform logic, so there is no reason to fake it.
 * Configure `PRIVY_APP_ID` / `PRIVY_APP_SECRET` to use it for real.
 *
 * `ensureWalletBoundOrRespond` is a deliberately simplified reimplementation
 * of the private platform's `lib/auth/wallet-bound-auth.ts`: it verifies a
 * Privy bearer token and checks the `X-Active-Wallet` header against the
 * caller's Privy-linked wallets. The original also supports a cookie-token
 * fallback and a richer `WalletValidationError` hierarchy for host-specific
 * failure reporting — dropped here as non-essential to the carve-out. See
 * the README's "supported vs reference" table.
 *
 * `resolveSafeLinkedWalletCandidates` is NOT reimplemented against Privy: in
 * the private platform it also cross-checks a `wallet_link_map` table that
 * prevents one wallet from lending its standing to multiple accounts (see
 * CLAUDE.md's "Linked Wallet And Wallet-Link-Map Rules"). That table isn't
 * part of this carve-out, so this is an adapter interface + fixture like the
 * quest engine: a real host must supply the anti-wallet-lending check.
 */
import { PrivyClient } from "@privy-io/server-auth";
import type { NextRequest, NextResponse } from "next/server";

let cachedClient: PrivyClient | null = null;

function getPrivyClient(): PrivyClient {
  if (cachedClient) return cachedClient;
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error(
      "PRIVY_APP_ID / PRIVY_APP_SECRET are not set — configure a real Privy " +
        "app to use the identity adapter, or supply a test double in tests.",
    );
  }
  cachedClient = new PrivyClient(appId, appSecret);
  return cachedClient;
}

export class WalletValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WalletValidationError";
  }
}

/** Minimal stand-in for the original's NextApiRequest/NextRequest-flavored `getPrivyUser`. */
export async function getPrivyUserFromNextRequest(
  req: NextRequest,
): Promise<{ id: string } | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) return null;
  try {
    const claims = await getPrivyClient().verifyAuthToken(token);
    return { id: claims.userId };
  } catch {
    return null;
  }
}

export async function getUserWalletAddresses(
  userId: string,
  options?: { allowEmptyOnError?: boolean },
): Promise<string[]> {
  try {
    const privy = getPrivyClient();
    const userProfile = await privy.getUserById(userId);
    const addresses: string[] = [];
    for (const account of userProfile.linkedAccounts ?? []) {
      if (account.type === "wallet" && "address" in account && account.address) {
        addresses.push(account.address);
      }
    }
    return addresses;
  } catch (error) {
    if (options?.allowEmptyOnError === false) throw error;
    return [];
  }
}

export interface LinkedWalletCandidateInput {
  supabase: unknown;
  privyUserId: string;
  linkedWallets: string[];
  preferredWallet?: string | null;
}

export type ResolveSafeLinkedWalletCandidates = (
  input: LinkedWalletCandidateInput,
) => Promise<`0x${string}`[]>;

/**
 * Fixture default: trusts every Privy-linked wallet unfiltered. This is
 * exactly the gap the private platform's wallet-link-map check closes (see
 * module docs above) — safe for local/demo use, NOT safe to run unmodified
 * against real funds/rewards. A real host must supply an implementation that
 * rejects a wallet already claimed by a different account.
 */
const fixtureResolveSafeLinkedWalletCandidates: ResolveSafeLinkedWalletCandidates =
  async ({ linkedWallets }) => linkedWallets as `0x${string}`[];

let activeResolver: ResolveSafeLinkedWalletCandidates =
  fixtureResolveSafeLinkedWalletCandidates;

export function configureLinkedWalletResolver(
  resolver: ResolveSafeLinkedWalletCandidates,
): void {
  activeResolver = resolver;
}

export const resolveSafeLinkedWalletCandidates: ResolveSafeLinkedWalletCandidates =
  (input) => activeResolver(input);

export interface WalletBoundContext {
  userId: string;
  walletAddress: string;
}

export async function ensureWalletBoundOrRespond(
  req: NextRequest,
  options: { context: string; requireWallet?: boolean },
): Promise<{ context: WalletBoundContext | null; response: NextResponse | null }> {
  const { NextResponse: Res } = await import("next/server");
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) {
    return {
      context: null,
      response: Res.json({ error: "AUTH_REQUIRED" }, { status: 401 }),
    };
  }

  let userId: string;
  try {
    const privy = getPrivyClient();
    const claims = await privy.verifyAuthToken(token);
    userId = claims.userId;
  } catch {
    return {
      context: null,
      response: Res.json({ error: "AUTH_INVALID" }, { status: 401 }),
    };
  }

  const activeWalletHeader = req.headers.get("x-active-wallet");
  if (options.requireWallet !== false && !activeWalletHeader) {
    return {
      context: null,
      response: Res.json({ error: "WALLET_REQUIRED" }, { status: 400 }),
    };
  }

  if (activeWalletHeader) {
    const linked = await getUserWalletAddresses(userId, { allowEmptyOnError: false });
    if (!linked.some((w) => w.toLowerCase() === activeWalletHeader.toLowerCase())) {
      return {
        context: null,
        response: Res.json({ error: "WALLET_NOT_OWNED" }, { status: 403 }),
      };
    }
  }

  return {
    context: { userId, walletAddress: activeWalletHeader ?? "" },
    response: null,
  };
}
