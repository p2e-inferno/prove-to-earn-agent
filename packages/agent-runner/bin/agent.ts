#!/usr/bin/env ts-node
import { loadConfig } from "../src/config";
import { createAgentWallet } from "../src/wallet";
import { runDailyQuest } from "../src/run";
import { assertAgentNetwork } from "../src/network";
import { AgentWorker } from "../src/worker";

async function register(): Promise<void> {
  const config = loadConfig();
  const wallet = await createAgentWallet(config);

  const ownerToken = process.env.P2E_OWNER_TOKEN;
  const rewardWallet = process.env.AGENT_REWARD_WALLET;
  if (!ownerToken || !rewardWallet) {
    throw new Error(
      "P2E_OWNER_TOKEN and AGENT_REWARD_WALLET are required to register",
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `Registering agent ${wallet.address} (${wallet.provider} wallet)`,
  );

  const grantResponse = await fetch(
    `${config.gatewayBaseUrl}/api/agent/v1/register/grant`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        agentWallet: wallet.address,
        rewardWallet,
        capabilities: [
          "quests.read",
          "quests.start",
          "tasks.complete",
          "tasks.claim",
          "quests.complete",
        ],
        templateIds: process.env.AGENT_TEMPLATE_IDS
          ? process.env.AGENT_TEMPLATE_IDS.split(",")
          : [],
      }),
    },
  ).then((r) => r.json());

  if (!grantResponse?.data?.typedData) {
    throw new Error(
      `Grant failed: ${grantResponse?.message ?? "unknown error"}`,
    );
  }

  const { domain, types, message } = grantResponse.data.typedData;
  const agentSignature = await wallet.signTypedData({
    domain,
    types,
    primaryType: "AgentGrant",
    message,
  });

  const registered = await fetch(
    `${config.gatewayBaseUrl}/api/agent/v1/register`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonce: grantResponse.data.nonce,
        agentSignature,
        label: config.agentName ?? process.env.AGENT_LABEL ?? "quest-runner",
      }),
    },
  ).then((r) => r.json());

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(registered, null, 2));

  if (registered?.ok !== true) {
    throw new Error(registered?.message ?? "Registration failed");
  }
}

async function run(): Promise<void> {
  const config = loadConfig();
  const wallet = await createAgentWallet(config);

  // eslint-disable-next-line no-console
  console.log(`Agent wallet: ${wallet.address} (${wallet.provider})`);

  await assertAgentNetwork(wallet, config);

  const report = await runDailyQuest(wallet, config, {
    runId: process.env.AGENT_RUN_ID,
    dryRun: process.env.AGENT_DRY_RUN === "true",
  });

  // eslint-disable-next-line no-console
  console.log(`\n${report.narrative.headline}\n${report.narrative.summary}`);
  if (report.narrative.nextSteps.length) {
    // eslint-disable-next-line no-console
    console.log("\nNext steps:");
    for (const step of report.narrative.nextSteps) {
      // eslint-disable-next-line no-console
      console.log(` - ${step}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\n${JSON.stringify(report.tasks, null, 2)}`);

  if (!report.succeeded) {
    throw new Error(report.narrative.headline);
  }
}

/** Long-lived mode: leases, checkpoints and survives restarts. */
async function work(): Promise<void> {
  const config = loadConfig();
  const wallet = await createAgentWallet(config);

  // eslint-disable-next-line no-console
  console.log(
    `Worker starting for ${wallet.address} (${wallet.provider}), polling every ${config.pollIntervalMs}ms`,
  );

  const worker = new AgentWorker(wallet, config, {
    runId: process.env.AGENT_RUN_ID,
  });
  const cycles = await worker.start();

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      cycles.map((cycle) => cycle.outcome),
      null,
      2,
    ),
  );
}

/** Verify the environment end to end without broadcasting anything. */
async function preflight(): Promise<void> {
  const config = loadConfig();
  const wallet = await createAgentWallet(config);
  const checks = await assertAgentNetwork(wallet, config);

  // eslint-disable-next-line no-console
  console.log(
    checks.map((check) => `  ok  ${check.name}`).join("\n") ||
      "  no checks ran",
  );
  // eslint-disable-next-line no-console
  console.log(
    `\nAgent ${wallet.address} is aligned on chain ${config.chainId}.`,
  );
}

async function address(): Promise<void> {
  const config = loadConfig();
  const wallet = await createAgentWallet(config);
  // eslint-disable-next-line no-console
  console.log(wallet.address);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "run";
  if (command === "register") return register();
  if (command === "run") return run();
  if (command === "work") return work();
  if (command === "preflight") return preflight();
  if (command === "address") return address();
  throw new Error(
    `Unknown command: ${command}. Use "register", "run", "work", "preflight" or "address".`,
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
