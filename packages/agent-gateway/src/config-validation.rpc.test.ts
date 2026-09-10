jest.mock("@/lib/upstash/redis", () => ({
  isUpstashRedisConfigured: () => true,
}));

import { validateAgentPlatformConfig } from "./config-validation";

const RPC_ENV = [
  "AGENT_RPC_URL",
  "NEXT_PUBLIC_ALCHEMY_API_KEY",
  "NEXT_PUBLIC_INFURA_API_KEY",
  "NEXT_PUBLIC_BASE_MAINNET_RPC_URL",
] as const;

function baseMainnetRpcConfigured() {
  const check = validateAgentPlatformConfig().checks.find(
    (entry) => entry.name === "BASE_MAINNET_RPC",
  );
  expect(check).toBeDefined();
  return check!.configured;
}

describe("agent platform readiness: Base mainnet RPC", () => {
  const saved = new Map(RPC_ENV.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    for (const name of RPC_ENV) delete process.env[name];
  });

  afterAll(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("fails when nothing resolves Base mainnet", () => {
    expect(baseMainnetRpcConfigured()).toBe(false);
  });

  it("accepts the runner's AGENT_RPC_URL override", () => {
    process.env.AGENT_RPC_URL = "https://base.example.com/rpc";
    expect(baseMainnetRpcConfigured()).toBe(true);
  });

  it("accepts a keyed provider without NEXT_PUBLIC_BASE_MAINNET_RPC_URL", () => {
    process.env.NEXT_PUBLIC_ALCHEMY_API_KEY = "alchemy-key";
    expect(baseMainnetRpcConfigured()).toBe(true);
  });

  it("rejects a keyless provider base that has no API key to join", () => {
    process.env.NEXT_PUBLIC_BASE_MAINNET_RPC_URL =
      "https://base-mainnet.g.alchemy.com/v2/";
    expect(baseMainnetRpcConfigured()).toBe(false);
  });

  it("accepts a full NEXT_PUBLIC_BASE_MAINNET_RPC_URL endpoint", () => {
    process.env.NEXT_PUBLIC_BASE_MAINNET_RPC_URL =
      "https://base-mainnet.g.alchemy.com/v2/alchemy-key";
    expect(baseMainnetRpcConfigured()).toBe(true);
  });
});
