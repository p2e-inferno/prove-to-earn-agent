/**
 * @jest-environment node
 */
import { loadConfig, loadPlatformConfig } from "./config";

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

  it("validates the funding-swap budget", () => {
    process.env.AGENT_WALLET_PROVIDER = "local";
    process.env.AGENT_PRIVATE_KEY = "0x01";
    process.env.AGENT_MAX_FUNDING_SWAPS = "-1";

    expect(() => loadConfig()).toThrow(/AGENT_MAX_FUNDING_SWAPS/);
  });

  it("treats an omitted funding-swap budget as uncapped", () => {
    process.env.AGENT_WALLET_PROVIDER = "local";
    process.env.AGENT_PRIVATE_KEY = "0x01";
    delete process.env.AGENT_MAX_FUNDING_SWAPS;

    expect(loadConfig().maxFundingSwaps).toBeNull();
  });

  it("rejects a funding-swap budget above the planner bound", () => {
    process.env.AGENT_WALLET_PROVIDER = "local";
    process.env.AGENT_PRIVATE_KEY = "0x01";
    process.env.AGENT_MAX_FUNDING_SWAPS = "33";

    expect(() => loadConfig()).toThrow(/AGENT_MAX_FUNDING_SWAPS/);
  });

  it("uses the platform OpenRouter model for hosted agents", () => {
    delete process.env.AGENT_LLM_MODEL;
    process.env.OPENROUTER_DEFAULT_MODEL = "provider/platform-model";

    expect(
      loadPlatformConfig({
        providerAccountName: "p2e-12345678123412341234123456789012",
        maxFundingSwaps: 3,
      }).llmModel,
    ).toBe("provider/platform-model");
  });
});

it.each(["NaN", "-1", "5001", "1.5"])(
  "rejects malformed hosted slippage %s",
  (value) => {
    process.env.AGENT_SLIPPAGE_BPS = value;
    expect(() =>
      loadPlatformConfig({ providerAccountName: "agent", maxFundingSwaps: 3 }),
    ).toThrow("AGENT_SLIPPAGE_BPS");
  },
);
