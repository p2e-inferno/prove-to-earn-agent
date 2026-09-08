/**
 * @jest-environment node
 */
import { loadConfig } from "./config";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("loadConfig wallet provider", () => {
  it("defaults to CDP so each agent gets its own custodied wallet", () => {
    process.env.AGENT_NAME = "agent-alice";
    delete process.env.AGENT_WALLET_PROVIDER;

    expect(loadConfig().walletProvider).toBe("cdp");
  });

  /**
   * A CDP account is addressed by name, so a missing name would silently share
   * one wallet across every agent — the defect this check exists to prevent.
   */
  it("refuses CDP without an agent name", () => {
    delete process.env.AGENT_NAME;
    process.env.AGENT_WALLET_PROVIDER = "cdp";

    expect(() => loadConfig()).toThrow(/AGENT_NAME is required/);
  });

  it("refuses the local provider without a key", () => {
    process.env.AGENT_WALLET_PROVIDER = "local";
    delete process.env.AGENT_PRIVATE_KEY;

    expect(() => loadConfig()).toThrow(/AGENT_PRIVATE_KEY is required/);
  });

  it("accepts the local provider for development", () => {
    process.env.AGENT_WALLET_PROVIDER = "local";
    process.env.AGENT_PRIVATE_KEY = "0x01";

    const config = loadConfig();
    expect(config.walletProvider).toBe("local");
    expect(config.agentPrivateKey).toBe("0x01");
  });
});
