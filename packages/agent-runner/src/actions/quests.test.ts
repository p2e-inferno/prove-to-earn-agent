/**
 * @jest-environment node
 */

import { decodeFunctionData } from "viem";
import { UNLOCK_FACTORY_ABI } from "@vendor/blockchain/abi-definitions";
import { UNLOCK_FACTORY_ADDRESSES } from "@vendor/unlock-factory-addresses";
import { dailyCheckinAction, deployLockAction, gasDropAction } from "./quests";
import { resultTxHash, type ActionContext } from "./types";

const sendTransaction = jest.fn();
const waitForReceipt = jest.fn();
const getBlockNumber = jest.fn();
const estimateGas = jest.fn();
const getGasPrice = jest.fn();

const AGENT = "0x0000000000000000000000000000000000000a9e";

const ctx = {
  wallet: {
    address: AGENT,
    publicClient: { getBlockNumber, estimateGas, getGasPrice },
    sendTransaction: (...args: unknown[]) => sendTransaction(...args),
    waitForReceipt: (...args: unknown[]) => waitForReceipt(...args),
  },
  config: { chainId: 8453 },
  purpose: { kind: "quest_task", taskId: "t1" },
  stateVersion: "s1",
} as unknown as ActionContext;

const baseConfig = {
  allowed_networks: [{ chain_id: 8453, reward_ratio: 1, enabled: true }],
};

beforeEach(() => {
  jest.clearAllMocks();
  getBlockNumber.mockResolvedValue(100n);
  estimateGas.mockResolvedValue(250_000n);
  getGasPrice.mockResolvedValue(1_000_000n);
  sendTransaction.mockResolvedValue(`0x${"11".repeat(32)}`);
  waitForReceipt.mockResolvedValue({ status: "success" });
});

describe("deploy_lock", () => {
  it("accepts a task that allows Base", () => {
    expect(deployLockAction.parseTaskConfig(baseConfig)).toMatchObject({
      chainId: 8453,
    });
  });

  it("refuses a task that does not allow the only chain it signs for", () => {
    // Producing a candidate here would deploy on a chain the verifier never
    // checks, so the task is rejected before it can be offered.
    expect(() =>
      deployLockAction.parseTaskConfig({
        allowed_networks: [{ chain_id: 10, enabled: true }],
      }),
    ).toThrow(/Base mainnet/);
  });

  it("refuses a task where Base is present but disabled", () => {
    expect(() =>
      deployLockAction.parseTaskConfig({
        allowed_networks: [{ chain_id: 8453, enabled: false }],
      }),
    ).toThrow(/Base mainnet/);
  });

  it("refuses a task with no allowed networks at all", () => {
    expect(() => deployLockAction.parseTaskConfig({})).toThrow();
  });

  it("deploys through the official Unlock factory", async () => {
    const input = deployLockAction.parseTaskConfig(baseConfig);

    await deployLockAction.execute(ctx, input);

    const [sent] = sendTransaction.mock.calls[0]! as [
      { to: string; data: `0x${string}` },
    ];
    // The verifier requires a NewLock event from the official factory, so any
    // other target fails verification no matter what it deploys.
    expect(sent.to.toLowerCase()).toBe(
      UNLOCK_FACTORY_ADDRESSES[8453]!.toLowerCase(),
    );
    expect(
      decodeFunctionData({ abi: UNLOCK_FACTORY_ABI, data: sent.data })
        .functionName,
    ).toBe("createUpgradeableLockAtVersion");
  });

  it("leaves the agent wallet as the only lock manager", async () => {
    const input = deployLockAction.parseTaskConfig(baseConfig);

    await deployLockAction.execute(ctx, input);

    const [sent] = sendTransaction.mock.calls[0]! as [{ data: `0x${string}` }];
    const decoded = decodeFunctionData({
      abi: UNLOCK_FACTORY_ABI,
      data: sent.data,
    });
    const postDeploy = decoded.args?.[2] as readonly `0x${string}`[];

    // The factory renounces itself, so no residual authority survives.
    expect(postDeploy).toHaveLength(2);
    expect(postDeploy[0]!.toLowerCase()).toContain(
      AGENT.slice(2).toLowerCase(),
    );
  });

  it("reports a reverted deployment as state_changed, not failed", async () => {
    waitForReceipt.mockResolvedValue({ status: "reverted" });
    const input = deployLockAction.parseTaskConfig(baseConfig);

    const result = await deployLockAction.execute(ctx, input);

    expect(result).toMatchObject({
      status: "state_changed",
      code: "TX_REVERTED",
    });
  });

  it("is analysed as executable with no asset requirements", async () => {
    const input = deployLockAction.parseTaskConfig(baseConfig);

    const analysis = await deployLockAction.analyze(ctx, input);

    expect(analysis.executableNow).toBe(true);
    expect(analysis.requirements).toEqual([]);
    expect(analysis.economics!.gas).toMatchObject({
      estimateRaw: "250000",
      priceRaw: "1000000",
      costRaw: "250000000000",
      method: "measured",
    });
  });

  it("signs only for Base mainnet", () => {
    expect(deployLockAction.supportsNetwork(8453)).toBe(true);
    expect(deployLockAction.supportsNetwork(84532)).toBe(false);
  });
});

describe("daily_checkin", () => {
  it("needs no configuration", () => {
    expect(dailyCheckinAction.parseTaskConfig({ anything: 1 })).toEqual({});
  });

  it("sends no transaction and returns no hash", async () => {
    const result = await dailyCheckinAction.execute(ctx, {});

    // The server reads the acting wallet the gateway authenticated; there is
    // no subject for the agent to name, which is what makes it safe here.
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(result.status).toBe("confirmed");
    expect(resultTxHash(result)).toBeNull();
  });

  it("is always executable and costs no gas", async () => {
    const analysis = await dailyCheckinAction.analyze(ctx, {});

    expect(analysis.executableNow).toBe(true);
    expect(analysis.gasEstimateRaw).toBe("0");
    expect(analysis.economics!.gas.method).toBe("measured");
    expect(analysis.blockers).toEqual([]);
  });
});

describe("gas_drop", () => {
  it("accepts only a positive Base-mainnet amount", () => {
    expect(
      gasDropAction.parseTaskConfig({ chain_id: 8453, amount_wei: "1000" }),
    ).toEqual({ chainId: 8453, amountWei: "1000" });
    expect(() =>
      gasDropAction.parseTaskConfig({ chain_id: 84532, amount_wei: "1000" }),
    ).toThrow();
  });

  it("delegates the idempotent send to the gateway without a wallet transaction", async () => {
    const input = { chainId: 8453 as const, amountWei: "1000" };
    const result = await gasDropAction.execute(ctx, input);

    expect(sendTransaction).not.toHaveBeenCalled();
    expect(resultTxHash(result)).toBeNull();
  });
});
