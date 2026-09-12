/**
 * Minimal usage example: wire a host's quest adapter (here, the in-memory
 * fixture) into the gateway's contract and drive one quest run end-to-end
 * through the same functions the HTTP routes call.
 *
 * Run with: npx ts-node --project tsconfig.json examples/minimal-usage/run.ts
 * No environment variables required — this only exercises the fixture
 * QuestAdapter, not the datastore/identity/attestation adapters (those need
 * real credentials; see .env.example and the README's "supported vs
 * reference" table).
 */
import {
  configureQuestAdapter,
  listDailyQuests,
  startDailyQuest,
  completeDailyTask,
  completeDailyQuest,
  claimDailyTaskReward,
} from "../../src/adapters/quests";
import { inMemoryQuestAdapter } from "../../src/adapters/fixtures/quest-adapter";
import type { QuestPrincipal } from "../../src/vendor/quests/principal";

async function main() {
  // A real host calls configureQuestAdapter(myRealAdapter) once at boot,
  // implementing the QuestAdapter interface in src/adapters/quests.ts
  // against their own quest/reward system. We're explicit here even though
  // the fixture is already the default, so the wiring point is visible.
  configureQuestAdapter(inMemoryQuestAdapter);

  const principal: QuestPrincipal = {
    userId: "demo-owner",
    executionWallet: "0xAgentWallet",
    rewardWallet: "0xOwnerWallet",
    actorKind: "agent",
    agentId: "demo-agent",
  };

  const catalogue = await listDailyQuests(principal);
  console.log("1. catalogue:", catalogue.body);

  const runId = "run-demo-1";
  const started = await startDailyQuest(principal, runId);
  console.log("2. started:", started.body);

  const taskDone = await completeDailyTask(principal, {
    dailyQuestRunId: runId,
    dailyQuestRunTaskId: "task-demo-1",
  });
  console.log("3. task completed:", taskDone.body);

  const questDone = await completeDailyQuest(principal, runId);
  console.log("4. quest completed:", questDone.body);

  const claimed = await claimDailyTaskReward(principal, {
    completionId: `${runId}-completion`,
  });
  console.log("5. reward claimed:", claimed.body);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
