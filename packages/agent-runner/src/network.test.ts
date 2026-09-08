/**
 * @jest-environment node
 */

import {
  assertAgentNetwork,
  NetworkMismatchError,
  BASE_MAINNET_CHAIN_ID,
} from "./network";
import type { AgentWallet } from "./wallet";
import type { RunnerConfig } from "./config";

const getChainId = jest.fn();
const getBytecode = jest.fn();
const readContract = jest.fn();

const wallet = {
  address: "0x0000000000000000000000000000000000000a9e",
  caip2: `eip155:${BASE_MAINNET_CHAIN_ID}`,
  publicClient: { getChainId, getBytecode, readContract },
} as unknown as AgentWallet;

const config = { chainId: BASE_MAINNET_CHAIN_ID } as unknown as RunnerConfig;

async function failureNames(run: () => Promise<unknown>): Promise<string[]> {
  try {
    await run();
    return [];
  } catch (error) {
    if (!(error instanceof NetworkMismatchError)) throw error;
    return error.checks.filter((check) => !check.ok).map((check) => check.name);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.AGENT_X402_NETWORK;
  delete process.env.GRAPH_NETWORK;
  process.env.NEXT_PUBLIC_DG_VENDOR_ADDRESS =
    "0x45adA67dc9a5fb49c5f1A88f0ff83fb0550b3A82";
  getChainId.mockResolvedValue(BASE_MAINNET_CHAIN_ID);
  getBytecode.mockResolvedValue("0x6080604052");
  readContract.mockImplementation(
    async (args: { address: string; functionName: string }) => {
      if (args.functionName === "getTokenConfig") {
        return {
          baseToken: "0xaC27fa800955849d6D17cC8952Ba9dD6EAA66187",
          swapToken: "0x00000000000000000000000000000000000000D6",
        };
      }
      if (args.functionName === "symbol") {
        const address = args.address.toLowerCase();
        if (address === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")
          return "USDC";
        if (address === "0xac27fa800955849d6d17cc8952ba9dd6eaa66187")
          return "UP";
        return "DG";
      }
      if (args.functionName === "decimals") {
        return args.address.toLowerCase() ===
          "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
          ? 6
          : 18;
      }
      throw new Error("unexpected read");
    },
  );
});

describe("assertAgentNetwork", () => {
  it("passes when every layer names Base mainnet", async () => {
    const checks = await assertAgentNetwork(wallet, config);

    expect(checks.every((check) => check.ok)).toBe(true);
  });

  it("refuses to start without a valid vendor address", async () => {
    delete process.env.NEXT_PUBLIC_DG_VENDOR_ADDRESS;

    await expect(
      failureNames(() => assertAgentNetwork(wallet, config)),
    ).resolves.toContain("vendor.address");
  });

  it("refuses when the RPC is on another chain", async () => {
    getChainId.mockResolvedValue(84532);

    // A testnet RPC with mainnet addresses is the exact production accident
    // this gate exists to stop before a transaction is signed.
    await expect(
      failureNames(() => assertAgentNetwork(wallet, config)),
    ).resolves.toContain("rpc.chainId");
  });

  it("refuses when a required contract has no bytecode", async () => {
    getBytecode.mockResolvedValue("0x");

    const failed = await failureNames(() => assertAgentNetwork(wallet, config));

    expect(failed).toEqual(
      expect.arrayContaining([expect.stringMatching(/^bytecode\./)]),
    );
  });

  it("refuses when the RPC cannot be reached at all", async () => {
    getChainId.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      failureNames(() => assertAgentNetwork(wallet, config)),
    ).resolves.toContain("rpc.reachable");
  });

  it("refuses when x402 settles on a different network", async () => {
    process.env.AGENT_X402_NETWORK = "eip155:84532";

    // Paying on one chain and acting on another verifies as neither.
    await expect(
      failureNames(() => assertAgentNetwork(wallet, config)),
    ).resolves.toContain("x402.network");
  });

  it("refuses when the subgraph indexes another network", async () => {
    process.env.GRAPH_NETWORK = "base-sepolia";

    await expect(
      failureNames(() => assertAgentNetwork(wallet, config)),
    ).resolves.toContain("graph.network");
  });

  it("refuses when the wallet signs for another chain", async () => {
    const drifted = { ...wallet, caip2: "eip155:1" } as unknown as AgentWallet;

    await expect(
      failureNames(() => assertAgentNetwork(drifted, config)),
    ).resolves.toContain("wallet.caip2");
  });

  it("checks the vendor contract once it is configured", async () => {
    process.env.NEXT_PUBLIC_DG_VENDOR_ADDRESS =
      "0x45adA67dc9a5fb49c5f1A88f0ff83fb0550b3A82";

    await assertAgentNetwork(wallet, config);

    const checked = getBytecode.mock.calls.map(([args]) =>
      String((args as { address: string }).address).toLowerCase(),
    );
    expect(checked).toContain("0x45ada67dc9a5fb49c5f1a88f0ff83fb0550b3a82");
  });

  it("names every failure at once rather than one per restart", async () => {
    getChainId.mockResolvedValue(1);
    process.env.AGENT_X402_NETWORK = "eip155:84532";

    const failed = await failureNames(() => assertAgentNetwork(wallet, config));

    expect(failed).toEqual(
      expect.arrayContaining(["rpc.chainId", "x402.network"]),
    );
  });
});
