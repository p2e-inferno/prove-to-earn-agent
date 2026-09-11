import { encodeFunctionData } from "viem";
import { z } from "zod";
import {
  ADDITIONAL_LOCK_ABI,
  UNLOCK_FACTORY_ABI,
} from "@/lib/blockchain/shared/abi-definitions";
import { UNLOCK_FACTORY_ADDRESSES } from "@/constants/unlock_factory_addresses";
import {
  actionAnalysisSchema,
  actionEconomics,
  actionResultSchema,
  actionValue,
  assetAmount,
  confirmedResult,
  estimateActionGas,
  observedQuote,
  zeroGasEconomics,
  type ActionDefinition,
  type Blocker,
} from "./types";
import { BASE_MAINNET_CHAIN_ID } from "../network";

/**
 * The lock version the app's own deployments pin.
 *
 * The verifier only requires a `NewLock` event from the official factory, but
 * deploying at a version the app does not otherwise use would leave the owner
 * with a lock the rest of the product cannot manage.
 */
const LOCK_VERSION = 14;

function deployLockCall(parsed: DeployLockInput, owner: `0x${string}`) {
  const initialize = encodeFunctionData({
    abi: ADDITIONAL_LOCK_ABI,
    functionName: "initialize",
    args: [
      owner,
      BigInt(parsed.expirationDuration),
      "0x0000000000000000000000000000000000000000",
      0n,
      BigInt(parsed.maxNumberOfKeys),
      parsed.lockName,
    ],
  });
  const postDeploy = [
    encodeFunctionData({
      abi: ADDITIONAL_LOCK_ABI,
      functionName: "addLockManager",
      args: [owner],
    }),
    encodeFunctionData({
      abi: ADDITIONAL_LOCK_ABI,
      functionName: "renounceLockManager",
      args: [],
    }),
  ];
  return encodeFunctionData({
    abi: UNLOCK_FACTORY_ABI,
    functionName: "createUpgradeableLockAtVersion",
    args: [initialize, LOCK_VERSION, postDeploy],
  });
}

const deployLockInputSchema = z
  .object({
    chainId: z.literal(BASE_MAINNET_CHAIN_ID),
    lockName: z.string().min(1).max(64),
    expirationDuration: z.string().regex(/^\d+$/),
    maxNumberOfKeys: z.string().regex(/^\d+$/),
  })
  .strict();
export type DeployLockInput = z.infer<typeof deployLockInputSchema>;

const allowedNetworkSchema = z.object({
  chain_id: z.number().int(),
  reward_ratio: z.number().optional(),
  enabled: z.boolean().optional(),
});

/**
 * Deploy an Unlock lock the owner ends up managing.
 *
 * The agent is the lock creator and the only manager: nothing here nominates a
 * third party, and the factory renounces itself so no residual authority is
 * left behind.
 */
export const deployLockAction: ActionDefinition<DeployLockInput> = {
  name: "p2e_deploy_lock",
  version: 1,
  description:
    "Deploy an Unlock Protocol lock on Base through the official factory.",
  taskTypes: ["deploy_lock"],
  inputSchema: deployLockInputSchema,
  analysisSchema: actionAnalysisSchema,
  resultSchema: actionResultSchema,
  supportsNetwork: (chainId) => chainId === BASE_MAINNET_CHAIN_ID,

  parseTaskConfig(taskConfig) {
    const config = z
      .object({
        allowed_networks: z.array(allowedNetworkSchema).min(1),
        lock_name: z.string().min(1).max(64).optional(),
        expiration_duration: z.union([z.string(), z.number()]).optional(),
        max_number_of_keys: z.union([z.string(), z.number()]).optional(),
      })
      .passthrough()
      .parse(taskConfig);

    // The agent signs only on Base, so a task that does not allow Base is not
    // one it can perform — saying so here keeps it out of the candidate set.
    const base = config.allowed_networks.find(
      (network) =>
        network.chain_id === BASE_MAINNET_CHAIN_ID && network.enabled !== false,
    );
    if (!base) {
      throw new Error(
        "This task does not allow Base mainnet, which is the only chain this agent signs for",
      );
    }

    return deployLockInputSchema.parse({
      chainId: BASE_MAINNET_CHAIN_ID,
      lockName: config.lock_name ?? "P2E Quest Lock",
      expirationDuration: String(config.expiration_duration ?? 0),
      maxNumberOfKeys: String(config.max_number_of_keys ?? 0),
    });
  },

  async analyze(ctx, input) {
    const parsed = deployLockInputSchema.parse(input);
    const blockers: Blocker[] = [];
    if (!UNLOCK_FACTORY_ADDRESSES[parsed.chainId]) {
      blockers.push({
        code: "UNLOCK_UNSUPPORTED_CHAIN",
        message: `Unlock has no factory on chain ${parsed.chainId}.`,
        resolution: "fatal",
      });
    }

    const factory = UNLOCK_FACTORY_ADDRESSES[parsed.chainId];
    const [blockNumber, gas] = await Promise.all([
      ctx.wallet.publicClient.getBlockNumber().catch(() => null),
      factory
        ? estimateActionGas(ctx.wallet, {
            to: factory,
            data: deployLockCall(parsed, ctx.wallet.address),
          })
        : Promise.resolve({
            estimateRaw: null,
            priceRaw: null,
            costRaw: null,
            costUsd: null,
            method: "unavailable" as const,
            scope: "primary_transaction" as const,
          }),
    ]);

    return actionAnalysisSchema.parse({
      executableNow: blockers.length === 0,
      // Gas is the only input; the factory call itself is free.
      requirements: [],
      effects: [{ kind: "stage", estimatedChangeRaw: "1" }],
      blockers,
      gasEstimateRaw: gas.estimateRaw,
      economics: actionEconomics(gas),
      quote: observedQuote("contract", blockNumber),
    });
  },

  async execute(ctx, input) {
    const parsed = deployLockInputSchema.parse(input);
    const factory = UNLOCK_FACTORY_ADDRESSES[parsed.chainId];
    if (!factory) {
      return actionResultSchema.parse({
        status: "fatal_error",
        code: "UNLOCK_UNSUPPORTED_CHAIN",
        message: `Unlock has no factory on chain ${parsed.chainId}.`,
      });
    }

    await ctx.onTransactionPrepared?.({ approvals: [] });
    const txHash = await ctx.wallet.sendTransaction({
      to: factory,
      data: deployLockCall(parsed, ctx.wallet.address),
    });
    await ctx.onTransactionSubmitted?.({ txHash, approvals: [] });

    const receipt = await ctx.wallet.waitForReceipt(txHash);
    if (receipt.status !== "success") {
      return actionResultSchema.parse({
        status: "state_changed",
        code: "TX_REVERTED",
        message: "The lock deployment reverted; observe current state again.",
      });
    }
    return confirmedResult(txHash, []);
  },
};

const noInputSchema = z.object({}).strict();
export type NoInput = z.infer<typeof noInputSchema>;

const gasDropInputSchema = z
  .object({
    chainId: z.literal(BASE_MAINNET_CHAIN_ID),
    amountWei: z.string().regex(/^[1-9]\d*$/),
  })
  .strict();

export const gasDropAction: ActionDefinition<
  z.infer<typeof gasDropInputSchema>
> = {
  name: "p2e_gas_drop",
  version: 1,
  description:
    "Request the configured Base gas drop for the owner's reward wallet.",
  taskTypes: ["gas_drop"],
  inputSchema: gasDropInputSchema,
  analysisSchema: actionAnalysisSchema,
  resultSchema: actionResultSchema,
  supportsNetwork: (chainId) => chainId === BASE_MAINNET_CHAIN_ID,
  parseTaskConfig(taskConfig) {
    const config = z
      .object({
        chain_id: z.number().int(),
        amount_wei: z.string().regex(/^[1-9]\d*$/),
      })
      .passthrough()
      .parse(taskConfig);
    return gasDropInputSchema.parse({
      chainId: config.chain_id,
      amountWei: config.amount_wei,
    });
  },
  async analyze(_ctx, input) {
    const parsed = gasDropInputSchema.parse(input);
    return actionAnalysisSchema.parse({
      executableNow: true,
      requirements: [],
      effects: [
        {
          kind: "asset",
          asset: assetAmount("ETH", BigInt(parsed.amountWei), 18, null),
          estimatedChangeRaw: parsed.amountWei,
        },
      ],
      blockers: [],
      gasEstimateRaw: "0",
      economics: actionEconomics(
        zeroGasEconomics(),
        actionValue(
          null,
          assetAmount("ETH", BigInt(parsed.amountWei), 18, null),
        ),
      ),
      quote: observedQuote("task_config", null),
    });
  },
  async execute() {
    return confirmedResult(null, []);
  },
};

/**
 * A task the server settles from the caller's own identity.
 *
 * There is no transaction and no argument: the canonical verification service
 * reads the acting wallet the gateway already authenticated. That is exactly
 * why it is safe to automate — the agent cannot name a subject or a recipient,
 * so there is nothing here for it to point somewhere else.
 */
export const dailyCheckinAction: ActionDefinition<NoInput> = {
  name: "p2e_daily_checkin",
  version: 1,
  description: "Record the daily check-in for the acting wallet.",
  taskTypes: ["daily_checkin"],
  inputSchema: noInputSchema,
  analysisSchema: actionAnalysisSchema,
  resultSchema: actionResultSchema,
  supportsNetwork: (chainId) => chainId === BASE_MAINNET_CHAIN_ID,
  parseTaskConfig: () => ({}),

  async analyze() {
    return actionAnalysisSchema.parse({
      executableNow: true,
      requirements: [],
      effects: [{ kind: "points", estimatedChangeRaw: "1" }],
      blockers: [],
      gasEstimateRaw: "0",
      economics: actionEconomics(zeroGasEconomics()),
      quote: observedQuote("none", null),
    });
  },

  async execute() {
    // A null hash is the signal that the verifier reads state rather than a
    // receipt; the gateway submits the completion and the service does the work.
    return confirmedResult(null, []);
  },
};
