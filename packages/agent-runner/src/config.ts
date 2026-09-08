export type WalletProvider = "cdp" | "local";

export interface RunnerConfig {
  gatewayBaseUrl: string;
  walletProvider: WalletProvider;
  /** CDP account name. One per agent — this is what makes the runner multi-tenant. */
  agentName: string | null;
  /** Local development only; a single key cannot serve multiple users. */
  agentPrivateKey: string | null;
  /** Base mainnet — the chain the Uniswap verifier and x402 settlement share. */
  chainId: number;
  rpcUrl: string;
  /** Uniswap V3 on Base: the agent's own fills. */
  graphSubgraphId?: string;
  /** The DG vendor subgraph: the agent's own vendor activity. */
  graphVendorSubgraphId?: string;
  graphGatewayUrl: string;
  slippageBps?: number;
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

export function loadConfig(): RunnerConfig {
  const walletProvider = (
    process.env.AGENT_WALLET_PROVIDER === "local" ? "local" : "cdp"
  ) as WalletProvider;

  const config: RunnerConfig = {
    gatewayBaseUrl: (
      process.env.P2E_GATEWAY_URL || "http://localhost:3000"
    ).replace(/\/+$/, ""),
    walletProvider,
    agentName: process.env.AGENT_NAME?.trim() || null,
    agentPrivateKey: process.env.AGENT_PRIVATE_KEY?.trim() || null,
    chainId: Number(process.env.AGENT_CHAIN_ID || 8453),
    rpcUrl: process.env.AGENT_RPC_URL || "https://mainnet.base.org",
    graphSubgraphId: process.env.GRAPH_SUBGRAPH_ID,
    graphVendorSubgraphId: process.env.GRAPH_VENDOR_SUBGRAPH_ID,
    graphGatewayUrl:
      process.env.GRAPH_GATEWAY_URL || "https://gateway.thegraph.com",
    slippageBps: process.env.AGENT_SLIPPAGE_BPS
      ? Number(process.env.AGENT_SLIPPAGE_BPS)
      : undefined,
    llmModel: process.env.AGENT_LLM_MODEL?.trim() || undefined,
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

  if (walletProvider === "cdp" && !config.agentName) {
    throw new Error(
      "AGENT_NAME is required with the CDP wallet provider: it names this agent's own CDP account",
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
  if (
    !Number.isFinite(config.pollIntervalMs) ||
    config.pollIntervalMs! < 1_000
  ) {
    throw new Error("AGENT_POLL_INTERVAL_MS must be at least 1000");
  }

  return config;
}
