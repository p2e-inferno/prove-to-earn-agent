import { getClientRpcUrls } from "@/lib/blockchain/config";

export type WalletProvider = "cdp" | "local";

export interface RunnerConfig {
  gatewayBaseUrl: string;
  walletProvider: WalletProvider;
  /** CDP account name. One per agent — this is what makes the runner multi-tenant. */
  providerAccountName: string | null;
  /** Local development only; a single key cannot serve multiple users. */
  agentPrivateKey: string | null;
  /** Base mainnet — the chain the Uniswap verifier and x402 settlement share. */
  chainId: number;
  rpcUrl: string;
  /** Uniswap V3 on Base: the agent's own fills. */
  graphUniswapSubgraphId?: string;
  /** The DG vendor subgraph: the agent's own vendor activity. */
  graphVendorSubgraphId?: string;
  graphGatewayUrl: string;
  slippageBps?: number;
  maxFundingSwaps?: number;
  /**
   * Model for the narration. The provider is OpenRouter via lib/ai/client, the
   * same path the owner-facing chat uses; absent credentials mean deterministic
   * summaries, never a crash.
   */
  llmModel: string | undefined;
  llmFallbackModels?: string[];
  pollIntervalMs?: number;
  leaseSeconds?: number;
  leaseRenewMs?: number;
  claimFinalizationBufferSeconds?: number;
}

function commonConfig(): Omit<
  RunnerConfig,
  | "walletProvider"
  | "providerAccountName"
  | "agentPrivateKey"
  | "maxFundingSwaps"
> {
  return {
    gatewayBaseUrl: (
      process.env.P2E_GATEWAY_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      "http://localhost:3000"
    ).replace(/\/+$/, ""),
    chainId: 8453,
    // NEXT_PUBLIC_BASE_MAINNET_RPC_URL is a keyless Alchemy base that the app
    // joins with NEXT_PUBLIC_ALCHEMY_API_KEY, so reading it directly reaches an
    // unauthenticated endpoint. getClientRpcUrls performs that join.
    rpcUrl:
      process.env.AGENT_RPC_URL?.trim() ||
      getClientRpcUrls(8453)[0] ||
      "https://mainnet.base.org",
    graphUniswapSubgraphId: process.env.GRAPH_UNISWAP_SUBGRAPH_ID,
    graphVendorSubgraphId: process.env.GRAPH_VENDOR_SUBGRAPH_ID,
    graphGatewayUrl:
      process.env.GRAPH_GATEWAY_URL || "https://gateway.thegraph.com",
    slippageBps: process.env.AGENT_SLIPPAGE_BPS
      ? Number(process.env.AGENT_SLIPPAGE_BPS)
      : undefined,
    llmModel:
      process.env.AGENT_LLM_MODEL?.trim() ||
      process.env.OPENROUTER_DEFAULT_MODEL?.trim() ||
      undefined,
    llmFallbackModels: (process.env.AGENT_LLM_FALLBACK_MODELS ?? "")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean),
    pollIntervalMs: Number(process.env.AGENT_POLL_INTERVAL_MS || 30_000),
    leaseSeconds: 120,
    leaseRenewMs: 40_000,
    claimFinalizationBufferSeconds: Number(
      process.env.AGENT_CLAIM_FINALIZATION_BUFFER_SECONDS || 120,
    ),
  };
}

export function loadPlatformConfig(input: {
  providerAccountName: string;
  maxFundingSwaps: number;
}): RunnerConfig {
  const config: RunnerConfig = {
    ...commonConfig(),
    walletProvider: "cdp",
    providerAccountName: input.providerAccountName,
    agentPrivateKey: null,
    maxFundingSwaps: input.maxFundingSwaps,
  };
  validateRunnerConfig(config);
  return config;
}

export function loadConfig(): RunnerConfig {
  const walletProvider = (
    process.env.AGENT_WALLET_PROVIDER === "local" ? "local" : "cdp"
  ) as WalletProvider;

  const config: RunnerConfig = {
    ...commonConfig(),
    walletProvider,
    providerAccountName: process.env.AGENT_NAME?.trim() || null,
    agentPrivateKey: process.env.AGENT_PRIVATE_KEY?.trim() || null,
    chainId: Number(process.env.AGENT_CHAIN_ID || 8453),
    maxFundingSwaps: Number(process.env.AGENT_MAX_FUNDING_SWAPS || 20),
  };

  if (walletProvider === "cdp" && !config.providerAccountName) {
    throw new Error(
      "AGENT_NAME is required by the legacy CLI as its CDP provider account name",
    );
  }
  if (walletProvider === "local" && !config.agentPrivateKey) {
    throw new Error(
      "AGENT_PRIVATE_KEY is required with the local wallet provider",
    );
  }
  if (config.chainId !== 8453) {
    throw new Error(
      `AGENT_CHAIN_ID must be 8453 for Base mainnet, received ${config.chainId}`,
    );
  }
  validateRunnerConfig(config);

  return config;
}

export function validateRunnerConfig(config: RunnerConfig): void {
  if (
    !Number.isFinite(config.pollIntervalMs) ||
    config.pollIntervalMs! < 1_000
  ) {
    throw new Error("AGENT_POLL_INTERVAL_MS must be at least 1000");
  }
  if (
    !Number.isInteger(config.maxFundingSwaps) ||
    config.maxFundingSwaps! < 0 ||
    config.maxFundingSwaps! > 20
  ) {
    throw new Error("AGENT_MAX_FUNDING_SWAPS must be an integer from 0 to 20");
  }

  if (
    config.slippageBps !== undefined &&
    (!Number.isInteger(config.slippageBps) ||
      config.slippageBps < 1 ||
      config.slippageBps > 5000)
  ) {
    throw new Error("AGENT_SLIPPAGE_BPS must be an integer from 1 to 5000");
  }
  if (
    !Number.isFinite(config.claimFinalizationBufferSeconds) ||
    config.claimFinalizationBufferSeconds! < 0
  ) {
    throw new Error(
      "AGENT_CLAIM_FINALIZATION_BUFFER_SECONDS must be nonnegative",
    );
  }
}
