/**
 * @jest-environment node
 */

const ensureAllowance = jest.fn();

jest.mock("../approvals", () => ({
  ensureErc20Allowance: (...args: unknown[]) => ensureAllowance(...args),
}));

process.env.NEXT_PUBLIC_DG_VENDOR_ADDRESS =
  "0x45adA67dc9a5fb49c5f1A88f0ff83fb0550b3A82";

import {
  vendorBuyAction,
  vendorLevelUpAction,
  vendorLightUpAction,
  vendorSellAction,
} from "./vendor";
import { UNISWAP_ADDRESSES } from "@/lib/uniswap/constants";
import { resultApprovals, resultTxHash, type ActionContext } from "./types";

const simulateContract = jest.fn();
const readContract = jest.fn();
const sendTransaction = jest.fn();
const getBalance = jest.fn();
const getBlockNumber = jest.fn();
const waitForReceipt = jest.fn();

// The vendor's base token is UP, and `readBalances` reads UP at its canonical
// Uniswap address — the two must agree or every deficit is the full amount.
const BASE_TOKEN = UNISWAP_ADDRESSES.up;
const SWAP_TOKEN = "0x2222222222222222222222222222222222222222";

let stage = 0;
let points = 0n;
let fuel = 0n;
let paused = false;
let hasValidKey = true;
const requestedStages: number[] = [];
/** ERC-20 balances keyed by token address, so each asset can be starved alone. */
let tokenBalances: Record<string, bigint> = {};

const ctx = {
  wallet: {
    address: "0x0000000000000000000000000000000000000a9e",
    publicClient: {
      simulateContract,
      readContract,
      getBalance,
      getBlockNumber,
    },
    sendTransaction: (...args: unknown[]) => sendTransaction(...args),
    waitForReceipt: (...args: unknown[]) => waitForReceipt(...args),
  },
  config: { chainId: 8453 },
  purpose: { kind: "quest_task", taskId: "t1" },
  stateVersion: "v1",
} as unknown as ActionContext;

beforeEach(() => {
  jest.clearAllMocks();
  stage = 0;
  points = 0n;
  fuel = 0n;
  paused = false;
  hasValidKey = true;
  requestedStages.length = 0;
  tokenBalances = {
    [BASE_TOKEN.toLowerCase()]: 1_000_000n,
    [SWAP_TOKEN.toLowerCase()]: 1_000_000n,
  };
  simulateContract.mockResolvedValue({});
  sendTransaction.mockResolvedValue(`0x${"11".repeat(32)}`);
  waitForReceipt.mockResolvedValue({ status: "success" });
  getBalance.mockResolvedValue(10n ** 18n);
  getBlockNumber.mockResolvedValue(123n);
  ensureAllowance.mockResolvedValue([
    { step: "erc20-spender", txHash: `0x${"22".repeat(32)}` },
  ]);
  readContract.mockImplementation(
    ({
      functionName,
      address,
      args,
    }: {
      functionName: string;
      address: string;
      args?: readonly unknown[];
    }) => {
      switch (functionName) {
        case "getTokenConfig":
          return { baseToken: BASE_TOKEN, swapToken: SWAP_TOKEN };
        case "getFeeConfig":
          return { buyFeeBps: 100n, sellFeeBps: 200n };
        case "getExchangeRate":
          return 2n;
        case "getUserState":
          return { stage, points, fuel };
        case "getStageConfig":
          requestedStages.push(Number(args?.[0] ?? -1));
          return {
            burnAmount: 10n,
            fuelRate: 5n,
            upgradePointsThreshold: 100n,
            upgradeFuelThreshold: 50n,
            pointsAwarded: 2n,
            qualifyingBuyThreshold: 1000n,
          };
        case "paused":
          return paused;
        case "hasValidKey":
          return hasValidKey;
        case "balanceOf":
          return tokenBalances[String(address).toLowerCase()] ?? 0n;
        default:
          throw new Error(`Unstubbed read: ${functionName}`);
      }
    },
  );
});

const buy = { amountRaw: "1000" };
const sell = { amountRaw: "5000" };

describe("vendor analysis requirements and effects", () => {
  it("prices a buy against UP and predicts the DG it yields", async () => {
    const analysis = await vendorBuyAction.analyze(ctx, buy);

    expect(analysis.executableNow).toBe(true);
    expect(analysis.requirements[0]).toMatchObject({
      reference: { kind: "asset", asset: "UP", requiredRaw: "1000" },
    });
    // 1% fee then the exchange rate: the shared vendor math, not a local copy.
    expect(analysis.effects[0]).toMatchObject({
      kind: "asset",
      estimatedChangeRaw: "1980",
    });
  });

  it("prices a sell against DG and predicts the UP it yields", async () => {
    const analysis = await vendorSellAction.analyze(ctx, sell);

    expect(analysis.requirements[0]).toMatchObject({
      reference: { kind: "asset", asset: "DG", requiredRaw: "5000" },
    });
    expect(analysis.effects[0]?.kind).toBe("asset");
  });

  it("reports the exact UP deficit rather than only that it is short", async () => {
    tokenBalances[BASE_TOKEN.toLowerCase()] = 400n;

    const analysis = await vendorBuyAction.analyze(ctx, buy);

    expect(analysis.executableNow).toBe(false);
    expect(analysis.requirements[0]?.deficit?.raw).toBe("600");
    expect(analysis.blockers).toContainEqual(
      expect.objectContaining({ code: "INSUFFICIENT_UP", resolution: "agent" }),
    );
  });

  it("sizes the light-up requirement from the contract's stage config", async () => {
    tokenBalances[BASE_TOKEN.toLowerCase()] = 4n;

    const analysis = await vendorLightUpAction.analyze(ctx, {
      targetStage: null,
    });

    expect(analysis.requirements[0]?.required?.raw).toBe("10");
    expect(analysis.requirements[0]?.deficit?.raw).toBe("6");
    expect(analysis.effects[0]).toMatchObject({
      kind: "fuel",
      estimatedChangeRaw: "5",
    });
  });

  it("classifies a paused vendor as time-resolvable, not the agent's problem", async () => {
    paused = true;

    const analysis = await vendorBuyAction.analyze(ctx, buy);

    expect(analysis.executableNow).toBe(false);
    expect(analysis.blockers).toContainEqual(
      expect.objectContaining({ code: "VENDOR_PAUSED", resolution: "time" }),
    );
  });

  it("classifies a missing access key as owner-resolvable", async () => {
    hasValidKey = false;

    const analysis = await vendorBuyAction.analyze(ctx, buy);

    // Only the owner can obtain a key, so the agent must not spin on it.
    expect(analysis.blockers).toContainEqual(
      expect.objectContaining({
        code: "AGENT_WALLET_NOT_KEYHOLDER",
        resolution: "owner",
      }),
    );
  });
});

describe("vendor level-up", () => {
  it("reports both points and fuel deficits from live state", async () => {
    points = 40n;
    fuel = 10n;

    const analysis = await vendorLevelUpAction.analyze(ctx, {
      targetStage: 1,
    });

    expect(analysis.executableNow).toBe(false);
    expect(analysis.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "INSUFFICIENT_POINTS" }),
        expect.objectContaining({ code: "INSUFFICIENT_FUEL" }),
      ]),
    );
    expect(requestedStages).toContain(1);
  });

  it("is executable with nothing to do when the stage is already reached", async () => {
    stage = 2;

    const analysis = await vendorLevelUpAction.analyze(ctx, {
      targetStage: 1,
    });

    // The verifier reads the stage, not a receipt — refusing here would cost
    // the owner a completion they have already earned.
    expect(analysis.executableNow).toBe(true);
    expect(analysis.blockers).toEqual([]);
    expect(analysis.gasEstimateRaw).toBe("0");
  });

  it("sends no transaction when the wallet already meets the target", async () => {
    stage = 2;

    const result = await vendorLevelUpAction.execute(ctx, { targetStage: 1 });

    expect(result.status).toBe("confirmed");
    expect(resultTxHash(result)).toBeNull();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("upgrades when the wallet is short of the target", async () => {
    stage = 0;
    points = 1000n;
    fuel = 1000n;

    await vendorLevelUpAction.execute(ctx, { targetStage: 1 });

    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("vendor execution", () => {
  it("approves the base token before buying and reports the approval", async () => {
    const result = await vendorBuyAction.execute(ctx, buy);

    expect(ensureAllowance.mock.calls[0]![1]).toBe(BASE_TOKEN);
    expect(result.status).toBe("confirmed");
    expect(resultApprovals(result)).toHaveLength(1);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("approves the swap token before selling", async () => {
    await vendorSellAction.execute(ctx, sell);

    expect(ensureAllowance.mock.calls[0]![1]).toBe(SWAP_TOKEN);
  });

  it("sizes the light-up approval from the contract's own stage config", async () => {
    await vendorLightUpAction.execute(ctx, { targetStage: null });

    expect(ensureAllowance.mock.calls[0]![1]).toBe(BASE_TOKEN);
    expect(ensureAllowance.mock.calls[0]![3]).toBe(10n);
  });

  it("returns state_changed rather than failed when the transaction reverts", async () => {
    waitForReceipt.mockResolvedValue({ status: "reverted" });

    const result = await vendorBuyAction.execute(ctx, buy);

    // A revert means the observation was stale; re-observing is the recovery,
    // not resubmitting the same call.
    expect(result).toMatchObject({
      status: "state_changed",
      code: "TX_REVERTED",
    });
  });
});

describe("task config parsing", () => {
  it.each([
    {},
    { required_amount: "0" },
    { required_amount: "abc" },
    { required_amount: "-5" },
  ])("refuses %p", (config) => {
    expect(() => vendorBuyAction.parseTaskConfig(config)).toThrow();
  });

  it("refuses an amount denominated in the token it cannot size against", () => {
    // The verifier compares swapTokenAmount, so passing required_amount
    // straight to buyTokens would verify as AMOUNT_TOO_LOW.
    expect(() =>
      vendorBuyAction.parseTaskConfig({
        required_amount: "1000",
        required_token: "swap",
      }),
    ).toThrow();
  });

  it("accepts the default denomination for each side", () => {
    expect(
      vendorBuyAction.parseTaskConfig({
        required_amount: "1000",
        required_token: "base",
      }),
    ).toEqual({ amountRaw: "1000" });
    expect(
      vendorSellAction.parseTaskConfig({ required_amount: "5000" }),
    ).toEqual({ amountRaw: "5000" });
  });

  it("reads an optional target stage for a level-up", () => {
    expect(vendorLevelUpAction.parseTaskConfig({ target_stage: "2" })).toEqual({
      targetStage: 2,
    });
    expect(vendorLevelUpAction.parseTaskConfig({})).toEqual({
      targetStage: null,
    });
  });
});

describe("network support", () => {
  it("refuses any chain but Base mainnet", () => {
    for (const action of [
      vendorBuyAction,
      vendorSellAction,
      vendorLightUpAction,
      vendorLevelUpAction,
    ]) {
      expect(action.supportsNetwork(8453)).toBe(true);
      expect(action.supportsNetwork(84532)).toBe(false);
    }
  });
});
