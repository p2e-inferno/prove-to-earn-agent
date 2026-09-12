/**
 * Quest adapter — the boundary between the agent gateway/runner and the
 * private platform's daily-quest engine.
 *
 * The private implementations of these functions
 * (`lib/quests/daily-quests/services/{read,start,complete-quest,
 * complete-task,claim-task-reward}.ts`) are not vendored here: they chain
 * into the XDG bucket/seat economy, abuse-flag checks, trial-run accounting,
 * on-chain key granting and attestation issuance — real product logic that
 * is out of scope for this carve-out (see the repo README's "carve-out
 * boundary" section).
 *
 * What *is* preserved exactly is the call-site contract: every gateway route
 * that used to import these functions from `@/lib/quests/daily-quests/services/*`
 * now imports the same function names/signatures from here. A host wires its
 * real quest engine in with `configureQuestAdapter(...)`; until it does, the
 * in-memory reference implementation in `./fixtures/quest-adapter.ts` answers
 * calls so the gateway is runnable and testable standalone.
 */
import type { QuestPrincipal, ServiceResult } from "../vendor/quests/principal";
import { inMemoryQuestAdapter } from "./fixtures/quest-adapter";

export interface CompleteTaskParams {
  dailyQuestRunId: string;
  dailyQuestRunTaskId: string;
  transactionHash?: string | null;
}

export interface ClaimTaskRewardParams {
  completionId: string;
  attestationSignature?: unknown;
}

export interface QuestAdapter {
  listDailyQuests(
    principal: QuestPrincipal | null,
    allowed?: string[],
  ): Promise<ServiceResult>;
  getDailyQuestRun(
    principal: QuestPrincipal,
    runId: string,
  ): Promise<ServiceResult>;
  startDailyQuest(
    principal: QuestPrincipal,
    runId: string,
  ): Promise<ServiceResult>;
  completeDailyQuest(
    principal: QuestPrincipal,
    runId: string,
  ): Promise<ServiceResult>;
  completeDailyTask(
    principal: QuestPrincipal,
    params: CompleteTaskParams,
  ): Promise<ServiceResult>;
  claimDailyTaskReward(
    principal: QuestPrincipal,
    params: ClaimTaskRewardParams,
  ): Promise<ServiceResult>;
}

let activeAdapter: QuestAdapter = inMemoryQuestAdapter;

/** Wire in a real quest engine. Call once, at host boot, before serving traffic. */
export function configureQuestAdapter(adapter: QuestAdapter): void {
  activeAdapter = adapter;
}

/** Test-only: restore the in-memory reference implementation. */
export function resetQuestAdapterForTests(): void {
  activeAdapter = inMemoryQuestAdapter;
}

export const listDailyQuests: QuestAdapter["listDailyQuests"] = (p, a) =>
  activeAdapter.listDailyQuests(p, a);
export const getDailyQuestRun: QuestAdapter["getDailyQuestRun"] = (p, r) =>
  activeAdapter.getDailyQuestRun(p, r);
export const startDailyQuest: QuestAdapter["startDailyQuest"] = (p, r) =>
  activeAdapter.startDailyQuest(p, r);
export const completeDailyQuest: QuestAdapter["completeDailyQuest"] = (p, r) =>
  activeAdapter.completeDailyQuest(p, r);
export const completeDailyTask: QuestAdapter["completeDailyTask"] = (p, params) =>
  activeAdapter.completeDailyTask(p, params);
export const claimDailyTaskReward: QuestAdapter["claimDailyTaskReward"] = (
  p,
  params,
) => activeAdapter.claimDailyTaskReward(p, params);
