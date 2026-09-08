import {
  createWalletClient,
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { base } from "viem/chains";
import type { RunnerConfig } from "./config";

/**
 * Signer shape x402's EVM scheme consumes. Both wallet providers satisfy it,
 * so payment signing never needs to know which one is in use.
 */
export interface X402Signer {
  readonly address: `0x${string}`;
  signTypedData(message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

/**
 * Narrow wallet surface the runner depends on.
 *
 * Kept small so the provider is swappable: a local key for development, a
 * CDP-custodied account per agent in production. Smart accounts are still NOT
 * usable — they submit UserOperations, and a userOpHash is not a transaction
 * hash, so the gateway's receipt verifiers reject them.
 */
export interface AgentWallet {
  address: Address;
  /** CAIP-2 id of the chain this wallet signs for. */
  caip2: string;
  /** Where the key lives, for reporting and operator sanity. */
  provider: "cdp" | "local";
  x402Signer: X402Signer;
  publicClient: PublicClient;
  sendTransaction(tx: {
    to: Address;
    data: `0x${string}`;
    value?: bigint;
  }): Promise<`0x${string}`>;
  signMessage(message: string): Promise<`0x${string}`>;
  signTypedData(args: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
  waitForReceipt(
    hash: `0x${string}`,
  ): Promise<{ status: "success" | "reverted" }>;
}

function clientsFor(config: RunnerConfig) {
  const transport = http(config.rpcUrl);
  return {
    transport,
    publicClient: createPublicClient({
      chain: base,
      transport,
    }) as PublicClient,
  };
}

/**
 * Development wallet: a raw key from the environment.
 *
 * One key is one agent forever, so this cannot serve multiple users. It exists
 * for local runs; production uses the CDP provider below.
 */
export function createLocalWallet(config: RunnerConfig): AgentWallet {
  if (!config.agentPrivateKey) {
    throw new Error(
      "AGENT_PRIVATE_KEY is required for the local wallet provider",
    );
  }

  const account = privateKeyToAccount(config.agentPrivateKey as `0x${string}`);
  const { transport, publicClient } = clientsFor(config);
  const walletClient = createWalletClient({ account, chain: base, transport });

  return {
    address: account.address,
    caip2: `eip155:${config.chainId}`,
    provider: "local",
    x402Signer: account as unknown as X402Signer,
    publicClient,

    async sendTransaction(tx) {
      return walletClient.sendTransaction({
        account,
        chain: base,
        to: tx.to,
        data: tx.data,
        value: tx.value ?? 0n,
      });
    },

    async signMessage(message) {
      return walletClient.signMessage({ account, message });
    },

    async signTypedData(args) {
      return walletClient.signTypedData({ account, ...args } as never);
    },

    async waitForReceipt(hash) {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });
      return { status: receipt.status };
    },
  };
}

/**
 * Production wallet: a CDP-custodied account, one per agent.
 *
 * `getOrCreateAccount({ name })` is what makes this multi-tenant — each
 * registered agent gets its own address derived from its own name, and the key
 * never exists in this process or in an env var. An env-var key would mean one
 * agent for the whole platform.
 */
export async function createCdpWallet(
  config: RunnerConfig,
): Promise<AgentWallet> {
  if (!config.agentName) {
    throw new Error("AGENT_NAME is required for the CDP wallet provider");
  }

  const { CdpClient } = await import("@coinbase/cdp-sdk");

  // Credentials resolve from CDP_API_KEY_ID / CDP_API_KEY_SECRET /
  // CDP_WALLET_SECRET unless passed explicitly.
  const cdp = new CdpClient();
  const cdpAccount = await cdp.evm.getOrCreateAccount({
    name: config.agentName,
  });

  const viemAccount = toAccount(cdpAccount as never);
  const { transport, publicClient } = clientsFor(config);
  const walletClient = createWalletClient({
    account: viemAccount,
    chain: base,
    transport,
  });

  return {
    address: cdpAccount.address as Address,
    caip2: `eip155:${config.chainId}`,
    provider: "cdp",
    // A CDP account already exposes { address, signTypedData }, which is the
    // signer shape x402 wants. Using it directly avoids
    // `@coinbase/cdp-sdk/x402`, whose eager `@x402/svm` require conflicts with
    // the `@solana/kit` version Privy pins in the web app.
    x402Signer: cdpAccount as unknown as X402Signer,
    publicClient,

    async sendTransaction(tx) {
      return walletClient.sendTransaction({
        account: viemAccount,
        chain: base,
        to: tx.to,
        data: tx.data,
        value: tx.value ?? 0n,
      });
    },

    async signMessage(message) {
      return walletClient.signMessage({ account: viemAccount, message });
    },

    async signTypedData(args) {
      return walletClient.signTypedData({
        account: viemAccount,
        ...args,
      } as never);
    },

    async waitForReceipt(hash) {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });
      return { status: receipt.status };
    },
  };
}

export async function createAgentWallet(
  config: RunnerConfig,
): Promise<AgentWallet> {
  return config.walletProvider === "cdp"
    ? createCdpWallet(config)
    : createLocalWallet(config);
}

/** Kept for callers that still construct a local wallet directly. */
export const createEoaWallet = createLocalWallet;
