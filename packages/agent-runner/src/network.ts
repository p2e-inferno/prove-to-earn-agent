import { UNISWAP_ADDRESSES } from "@vendor/uniswap/constants";
import { DG_TOKEN_VENDOR_ABI } from "@vendor/blockchain/vendor-abi";
import type { RunnerConfig } from "./config";
import type { AgentWallet } from "./wallet";

export const BASE_MAINNET_CHAIN_ID = 8453;

export interface NetworkCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export class NetworkMismatchError extends Error {
  constructor(readonly checks: NetworkCheck[]) {
    const failed = checks.filter((check) => !check.ok);
    super(
      `Agent network preflight failed: ${failed
        .map((check) => `${check.name} (${check.detail})`)
        .join("; ")}`,
    );
    this.name = "NetworkMismatchError";
  }
}

/** Contracts the agent will call; an empty address here is a wrong network. */
function requiredContracts(): Array<{ name: string; address: string }> {
  const contracts: Array<{ name: string; address: string }> = [
    {
      name: "uniswap.universalRouter",
      address: UNISWAP_ADDRESSES.universalRouter,
    },
    { name: "uniswap.permit2", address: UNISWAP_ADDRESSES.permit2 },
    { name: "uniswap.quoterV2", address: UNISWAP_ADDRESSES.quoterV2 },
    { name: "token.weth", address: UNISWAP_ADDRESSES.weth },
    { name: "token.usdc", address: UNISWAP_ADDRESSES.usdc },
    { name: "token.up", address: UNISWAP_ADDRESSES.up },
    ...Object.entries(UNISWAP_ADDRESSES.pools).map(([name, address]) => ({
      name: `pool.${name.toLowerCase()}`,
      address,
    })),
  ];
  const vendor = process.env.NEXT_PUBLIC_DG_VENDOR_ADDRESS;
  if (vendor) contracts.push({ name: "vendor", address: vendor });
  return contracts.filter((entry) =>
    /^0x[a-fA-F0-9]{40}$/.test(String(entry.address)),
  );
}

/**
 * Fail closed before the first transaction, not after it.
 *
 * The runner, the x402 settlement network, the quest verifier and the subgraph
 * must all name the same chain. A mismatch is silent at every layer until a
 * real transaction lands somewhere the verifier will never look for it, so the
 * check happens once at startup and refuses to proceed rather than warning.
 */
export async function assertAgentNetwork(
  wallet: AgentWallet,
  config: RunnerConfig,
): Promise<NetworkCheck[]> {
  const checks: NetworkCheck[] = [];
  const vendorAddress = process.env.NEXT_PUBLIC_DG_VENDOR_ADDRESS?.trim();

  checks.push({
    name: "config.chainId",
    ok: config.chainId === BASE_MAINNET_CHAIN_ID,
    detail: `configured ${config.chainId}, expected ${BASE_MAINNET_CHAIN_ID}`,
  });

  checks.push({
    name: "vendor.address",
    ok: Boolean(vendorAddress && /^0x[a-fA-F0-9]{40}$/.test(vendorAddress)),
    detail: vendorAddress
      ? "configured vendor address is invalid"
      : "NEXT_PUBLIC_DG_VENDOR_ADDRESS is required",
  });

  let observedChainId: number | null = null;
  try {
    observedChainId = await wallet.publicClient.getChainId();
  } catch (error) {
    checks.push({
      name: "rpc.reachable",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (observedChainId !== null) {
    checks.push({
      name: "rpc.chainId",
      ok: observedChainId === config.chainId,
      detail: `RPC reports ${observedChainId}, configured ${config.chainId}`,
    });
  }

  checks.push({
    name: "wallet.caip2",
    ok: wallet.caip2 === `eip155:${config.chainId}`,
    detail: `wallet signs for ${wallet.caip2}`,
  });

  // A correct address on the wrong chain has no code, which is the cheapest
  // way to catch a testnet RPC paired with mainnet addresses.
  for (const contract of requiredContracts()) {
    try {
      const bytecode = await wallet.publicClient.getBytecode({
        address: contract.address as `0x${string}`,
      });
      checks.push({
        name: `bytecode.${contract.name}`,
        ok: Boolean(bytecode && bytecode !== "0x"),
        detail: `no contract deployed at the configured ${contract.name} address`,
      });
    } catch (error) {
      checks.push({
        name: `bytecode.${contract.name}`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const erc20MetadataAbi = [
    {
      type: "function",
      name: "symbol",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "string" }],
    },
    {
      type: "function",
      name: "decimals",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "uint8" }],
    },
  ] as const;
  for (const token of [
    {
      name: "usdc",
      address: UNISWAP_ADDRESSES.usdc,
      symbol: "USDC",
      decimals: 6,
    },
    { name: "up", address: UNISWAP_ADDRESSES.up, symbol: "UP", decimals: 18 },
  ]) {
    try {
      const [symbol, decimals] = await Promise.all([
        wallet.publicClient.readContract({
          address: token.address,
          abi: erc20MetadataAbi,
          functionName: "symbol",
        }),
        wallet.publicClient.readContract({
          address: token.address,
          abi: erc20MetadataAbi,
          functionName: "decimals",
        }),
      ]);
      checks.push({
        name: `metadata.${token.name}`,
        ok: symbol === token.symbol && Number(decimals) === token.decimals,
        detail: `reported ${String(symbol)}/${String(decimals)}, expected ${token.symbol}/${token.decimals}`,
      });
    } catch (error) {
      checks.push({
        name: `metadata.${token.name}`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (vendorAddress && /^0x[a-fA-F0-9]{40}$/.test(vendorAddress)) {
    try {
      const tokens = (await wallet.publicClient.readContract({
        address: vendorAddress as `0x${string}`,
        abi: DG_TOKEN_VENDOR_ABI,
        functionName: "getTokenConfig",
      })) as { baseToken: string; swapToken: `0x${string}` };
      checks.push({
        name: "vendor.baseToken",
        ok:
          tokens.baseToken.toLowerCase() === UNISWAP_ADDRESSES.up.toLowerCase(),
        detail: `vendor base token is ${tokens.baseToken}`,
      });
      const [symbol, decimals] = await Promise.all([
        wallet.publicClient.readContract({
          address: tokens.swapToken,
          abi: erc20MetadataAbi,
          functionName: "symbol",
        }),
        wallet.publicClient.readContract({
          address: tokens.swapToken,
          abi: erc20MetadataAbi,
          functionName: "decimals",
        }),
      ]);
      checks.push({
        name: "vendor.swapToken",
        ok: symbol === "DG" && Number(decimals) === 18,
        detail: `vendor swap token reported ${String(symbol)}/${String(decimals)}`,
      });
    } catch (error) {
      checks.push({
        name: "vendor.tokens",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const settlementNetwork =
    process.env.AGENT_X402_NETWORK?.trim() || `eip155:${BASE_MAINNET_CHAIN_ID}`;
  checks.push({
    name: "x402.network",
    ok: settlementNetwork === `eip155:${config.chainId}`,
    detail: `settlement configured for ${settlementNetwork}`,
  });

  // The Graph is optional, but a subgraph indexing another chain would answer
  // confidently about a history that is not this agent's.
  const graphNetwork = process.env.GRAPH_NETWORK?.trim();
  if (
    graphNetwork ||
    config.graphUniswapSubgraphId ||
    config.graphVendorSubgraphId
  ) {
    checks.push({
      name: "graph.network",
      ok: graphNetwork === "base",
      detail: `subgraph network is ${graphNetwork ?? "unset"}, expected base`,
    });
  }

  if (checks.some((check) => !check.ok)) throw new NetworkMismatchError(checks);
  return checks;
}
