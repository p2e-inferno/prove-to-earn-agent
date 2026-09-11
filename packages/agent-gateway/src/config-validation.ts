import { loadPlatformConfig } from "@/packages/agent-runner/src/config";
import { isAddress } from "viem";
import { isUpstashRedisConfigured } from "@/lib/upstash/redis";

export interface AgentConfigCheck {
  name: string;
  configured: boolean;
  required: boolean;
}

function present(name: string) {
  return Boolean(process.env[name]?.trim());
}

function validUrl(name: string, fallback?: string) {
  const raw = process.env[name]?.trim() || fallback;
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

// NEXT_PUBLIC_BASE_MAINNET_RPC_URL is a keyless Alchemy base that the app's RPC
// resolver joins with NEXT_PUBLIC_ALCHEMY_API_KEY, so alone it reaches nothing.
function isKeylessProviderBase(raw: string) {
  return /\.(?:alchemy\.com|infura\.io)\//i.test(raw) && raw.endsWith("/");
}

// Either route the agent stack resolves Base mainnet through counts: the
// runner's AGENT_RPC_URL override, or the app's shared keyed-RPC resolution.
function hasBaseMainnetRpc() {
  if (validUrl("AGENT_RPC_URL")) return true;
  if (present("NEXT_PUBLIC_ALCHEMY_API_KEY")) return true;
  if (present("NEXT_PUBLIC_INFURA_API_KEY")) return true;
  const custom = process.env.NEXT_PUBLIC_BASE_MAINNET_RPC_URL?.trim();
  return Boolean(
    custom &&
    validUrl("NEXT_PUBLIC_BASE_MAINNET_RPC_URL") &&
    !isKeylessProviderBase(custom),
  );
}

export function validateAgentPlatformConfig() {
  let runnerValid = true;
  try {
    loadPlatformConfig({
      providerAccountName: "readiness",
      maxFundingSwaps: null,
    });
  } catch {
    runnerValid = false;
  }
  const checks: AgentConfigCheck[] = [
    {
      name: "NEXT_PUBLIC_DG_VENDOR_ADDRESS",
      configured: isAddress(process.env.NEXT_PUBLIC_DG_VENDOR_ADDRESS ?? ""),
      required: true,
    },
    { name: "RUNNER_SETTINGS", configured: runnerValid, required: true },
    {
      name: "GRAPH_API_KEY",
      configured: present("GRAPH_API_KEY"),
      required: true,
    },
    {
      name: "NEXT_PUBLIC_UNISWAP_FEE_WALLET",
      configured: isAddress(process.env.NEXT_PUBLIC_UNISWAP_FEE_WALLET ?? ""),
      required: true,
    },
    {
      name: "CDP_API_KEY_ID",
      configured: present("CDP_API_KEY_ID"),
      required: true,
    },
    {
      name: "CDP_API_KEY_SECRET",
      configured: present("CDP_API_KEY_SECRET"),
      required: true,
    },
    {
      name: "CDP_WALLET_SECRET",
      configured: present("CDP_WALLET_SECRET"),
      required: true,
    },
    {
      name: "INNGEST_EVENT_KEY",
      configured: present("INNGEST_EVENT_KEY"),
      required: true,
    },
    {
      name: "INNGEST_SIGNING_KEY",
      configured: present("INNGEST_SIGNING_KEY"),
      required: true,
    },
    {
      name: "AGENT_SESSION_JWT_SECRET",
      configured: present("AGENT_SESSION_JWT_SECRET"),
      required: true,
    },
    {
      name: "NEXT_PUBLIC_APP_URL",
      configured: validUrl("NEXT_PUBLIC_APP_URL"),
      required: true,
    },
    {
      name: "X402_PAY_TO_ADDRESS",
      configured: isAddress(process.env.X402_PAY_TO_ADDRESS ?? ""),
      required: true,
    },
    {
      name: "BASE_MAINNET_RPC",
      configured: hasBaseMainnetRpc(),
      required: true,
    },
    {
      name: "OPENROUTER_API_KEY",
      configured: present("OPENROUTER_API_KEY"),
      required: true,
    },
    {
      name: "OPENROUTER_DEFAULT_MODEL",
      configured:
        present("OPENROUTER_DEFAULT_MODEL") || present("AGENT_LLM_MODEL"),
      required: true,
    },
    {
      name: "GRAPH_VENDOR_SUBGRAPH_ID",
      configured: present("GRAPH_VENDOR_SUBGRAPH_ID"),
      required: true,
    },
    {
      name: "GRAPH_UNISWAP_SUBGRAPH_ID",
      configured: present("GRAPH_UNISWAP_SUBGRAPH_ID"),
      required: true,
    },
    {
      name: "UPSTASH_REDIS",
      configured: isUpstashRedisConfigured(),
      required: true,
    },
    {
      name: "WORLD_CHAIN_RPC_URL",
      configured: validUrl("WORLD_CHAIN_RPC_URL"),
      required: false,
    },
    {
      name: "WORLD_AGENTBOOK_RELAY_URL",
      configured: validUrl(
        "WORLD_AGENTBOOK_RELAY_URL",
        "https://x402-worldchain.vercel.app",
      ),
      required: false,
    },
  ];
  return {
    valid: checks.every((check) => !check.required || check.configured),
    checks,
  };
}
