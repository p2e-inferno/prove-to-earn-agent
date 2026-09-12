/**
 * In-memory reference `QuestAdapter`.
 *
 * This is a fixture for tests and the minimal usage example, not a
 * production quest engine: state lives in a process-local Map, there is no
 * persistence, no concurrency control, and the eligibility/reward rules are
 * deliberately trivial. A real host replaces this with an implementation
 * backed by their own quest/reward database — see `src/adapters/quests.ts`.
 */
import { fail, ok } from "../../vendor/quests/principal";
import type { QuestPrincipal, ServiceResult } from "../../vendor/quests/principal";
import type {
  ClaimTaskRewardParams,
  CompleteTaskParams,
  QuestAdapter,
} from "../quests";

interface FixtureTask {
  id: string;
  title: string;
  completed: boolean;
}

interface FixtureRun {
  id: string;
  templateTitle: string;
  status: "active" | "completed";
  tasks: FixtureTask[];
  completionId: string | null;
  claimed: boolean;
}

const runs = new Map<string, FixtureRun>();

function seed(): void {
  if (runs.size > 0) return;
  runs.set("run-demo-1", {
    id: "run-demo-1",
    templateTitle: "Say hello to The Graph",
    status: "active",
    tasks: [{ id: "task-demo-1", title: "Fetch recent vendor activity", completed: false }],
    completionId: null,
    claimed: false,
  });
}
seed();

export const inMemoryQuestAdapter: QuestAdapter = {
  async listDailyQuests(_principal: QuestPrincipal | null): Promise<ServiceResult> {
    return ok({
      quests: Array.from(runs.values()).map((r) => ({
        id: r.id,
        title: r.templateTitle,
        status: r.status,
      })),
    });
  },

  async getDailyQuestRun(_principal: QuestPrincipal, runId: string): Promise<ServiceResult> {
    const run = runs.get(runId);
    if (!run) return fail(404, "RUN_NOT_FOUND", "Quest run not found");
    return ok({ run });
  },

  async startDailyQuest(_principal: QuestPrincipal, runId: string): Promise<ServiceResult> {
    const run = runs.get(runId);
    if (!run) return fail(404, "RUN_NOT_FOUND", "Quest run not found");
    return ok({ run });
  },

  async completeDailyTask(
    _principal: QuestPrincipal,
    params: CompleteTaskParams,
  ): Promise<ServiceResult> {
    const run = runs.get(params.dailyQuestRunId);
    if (!run) return fail(404, "RUN_NOT_FOUND", "Quest run not found");
    const task = run.tasks.find((t) => t.id === params.dailyQuestRunTaskId);
    if (!task) return fail(404, "TASK_NOT_FOUND", "Task not found");
    task.completed = true;
    if (run.tasks.every((t) => t.completed)) {
      run.completionId = `${run.id}-completion`;
    }
    return ok({ task });
  },

  async completeDailyQuest(_principal: QuestPrincipal, runId: string): Promise<ServiceResult> {
    const run = runs.get(runId);
    if (!run) return fail(404, "RUN_NOT_FOUND", "Quest run not found");
    if (!run.tasks.every((t) => t.completed)) {
      return fail(409, "TASKS_INCOMPLETE", "Not all tasks are complete");
    }
    run.status = "completed";
    return ok({ run });
  },

  async claimDailyTaskReward(
    _principal: QuestPrincipal,
    params: ClaimTaskRewardParams,
  ): Promise<ServiceResult> {
    const run = Array.from(runs.values()).find(
      (r) => r.completionId === params.completionId,
    );
    if (!run) return fail(404, "COMPLETION_NOT_FOUND", "Completion not found");
    if (run.claimed) return fail(409, "ALREADY_CLAIMED", "Reward already claimed");
    run.claimed = true;
    return ok({ claimed: true, runId: run.id });
  },
};

/** Test-only: reset fixture state between test cases. */
export function __resetQuestFixtureForTests(): void {
  runs.clear();
  seed();
}
