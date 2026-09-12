import { createAgentAdminClient } from "@adapters/datastore";
import { listDailyQuests } from "@adapters/quests";
import type { QuestPrincipal } from "@vendor/quests/principal";
import { actionForTaskType } from "@/packages/agent-runner/src/actions/registry";
import { AGENT_REASON_CODES } from "@/packages/agent-gateway/src/codes";

const REQUIRED = [
  "quests.read",
  "quests.start",
  "tasks.complete",
  "tasks.claim",
  "quests.complete",
];

export interface BlockedQuest {
  runId: string | null;
  title: string | null;
  code:
    | "MISSING_CAPABILITY"
    | "TEMPLATE_SCOPE_MISMATCH"
    | "NOT_ELIGIBLE"
    | "TASK_UNSUPPORTED"
    | "UNSUPPORTED_CHAIN"
    | "INVALID_TASK_CONFIG";
  message: string;
  capability?: string;
  taskId?: string;
  taskType?: string;
}

export interface QuestAvailability {
  executable: Array<Record<string, unknown>>;
  blocked: BlockedQuest[];
}

function runIdentity(run: Record<string, unknown>) {
  const template = run.template as { title?: unknown } | null | undefined;
  return {
    runId: typeof run.id === "string" ? run.id : null,
    title: typeof template?.title === "string" ? template.title : "Quest",
  };
}

export async function describeQuestAvailability(
  principal: QuestPrincipal,
): Promise<QuestAvailability> {
  const { data: permissions, error } = await createAgentAdminClient()
    .from("agent_permissions")
    .select("capability, daily_quest_template_id")
    .eq("agent_id", principal.agentId!);
  if (error) throw error;
  const scopes = REQUIRED.map((capability) =>
    (permissions ?? [])
      .filter((row) => row.capability === capability)
      .map((row) => row.daily_quest_template_id),
  );
  const missingIndex = scopes.findIndex((scope) => scope.length === 0);
  if (missingIndex >= 0) {
    const capability = REQUIRED[missingIndex]!;
    return {
      executable: [],
      blocked: [
        {
          runId: null,
          title: null,
          code: AGENT_REASON_CODES.MISSING_CAPABILITY,
          message: `The agent is missing the ${capability} capability.`,
          capability,
        },
      ],
    };
  }
  const restricted = scopes.filter((scope) => !scope.includes(null));
  const allowed = restricted.length
    ? restricted[0]!.filter(
        (id): id is string =>
          id !== null && restricted.every((scope) => scope.includes(id)),
      )
    : undefined;
  if (allowed?.length === 0) {
    return {
      executable: [],
      blocked: [
        {
          runId: null,
          title: null,
          code: AGENT_REASON_CODES.TEMPLATE_SCOPE_MISMATCH,
          message:
            "The agent's capability grants do not overlap on one quest template.",
        },
      ],
    };
  }
  const result = await listDailyQuests(principal);
  if (result.status >= 300) throw new Error("QUEST_DISCOVERY_FAILED");
  const runs = (result.body as { runs: Array<Record<string, unknown>> }).runs;
  const executable: Array<Record<string, unknown>> = [];
  const blocked: BlockedQuest[] = [];
  for (const run of runs) {
    const identity = runIdentity(run);
    const template = run.template as { id?: unknown } | null | undefined;
    const templateId =
      typeof template?.id === "string"
        ? template.id
        : typeof run.daily_quest_template_id === "string"
          ? run.daily_quest_template_id
          : null;
    if (allowed && (!templateId || !allowed.includes(templateId))) {
      blocked.push({
        ...identity,
        code: AGENT_REASON_CODES.TEMPLATE_SCOPE_MISMATCH,
        message: "The agent is not granted this quest template.",
      });
      continue;
    }
    const eligibility = run.eligibility as
      | { eligible?: boolean; failures?: Array<{ message?: unknown }> }
      | undefined;
    if (!eligibility?.eligible) {
      const detail = eligibility?.failures
        ?.map((failure) =>
          typeof failure.message === "string" ? failure.message : null,
        )
        .filter((message): message is string => Boolean(message))
        .join("; ");
      blocked.push({
        ...identity,
        code: AGENT_REASON_CODES.NOT_ELIGIBLE,
        message:
          detail || "The owner is not currently eligible for this quest.",
      });
      continue;
    }
    const tasks = run.daily_quest_run_tasks as
      | Array<{ id?: string; task_type: string; task_config: unknown }>
      | undefined;
    const unrunnable = tasks
      ?.map((task) => {
        const action = actionForTaskType(task.task_type);
        if (!action) {
          return {
            task,
            code: AGENT_REASON_CODES.TASK_UNSUPPORTED,
            message: `Task type ${task.task_type} cannot be run by this agent.`,
          };
        }
        if (!action.supportsNetwork(8453)) {
          return {
            task,
            code: AGENT_REASON_CODES.UNSUPPORTED_CHAIN,
            message: `Task type ${task.task_type} is not supported on Base mainnet.`,
          };
        }
        const parsed = action.parse(task.task_config);
        return parsed.ok
          ? null
          : {
              task,
              code: AGENT_REASON_CODES.INVALID_TASK_CONFIG,
              message: parsed.reason,
            };
      })
      .find((reason) => reason !== null);
    if (!tasks?.length || unrunnable) {
      blocked.push({
        ...identity,
        code: unrunnable?.code ?? AGENT_REASON_CODES.TASK_UNSUPPORTED,
        message: unrunnable?.message ?? "The quest has no runnable tasks.",
        ...(unrunnable?.task.id ? { taskId: unrunnable.task.id } : {}),
        ...(unrunnable?.task.task_type
          ? { taskType: unrunnable.task.task_type }
          : {}),
      });
      continue;
    }
    executable.push(run);
  }
  return { executable, blocked };
}

export async function listExecutableQuests(principal: QuestPrincipal) {
  return (await describeQuestAvailability(principal)).executable;
}
