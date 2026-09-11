import { z } from "zod";
import { chatCompletion } from "@/lib/ai/client";
import type { AIConversationMessage, AIToolDefinition } from "@/lib/ai/types";
import {
  actionCandidateSchema,
  actionResultSchema,
  type ActionCandidate,
  type ActionResult,
} from "./actions/types";
import type { CandidateObservation, CandidateTask } from "./candidates";
import type { TaskOutcome } from "./brain";
import type { RunnerConfig } from "./config";

export const MAX_STEPS = 32;
const executeArgsSchema = z.object({ candidateId: z.string() }).strict();
const ownerArgsSchema = z
  .object({
    candidateId: z.string().optional(),
    question: z.string().min(1).max(1000),
  })
  .strict();

export interface OwnerQuestion {
  question: string;
  blockedTaskId: string | null;
}

export interface PlannerExecution {
  candidate: ActionCandidate;
  result: ActionResult;
  taskOutcome?: TaskOutcome;
}

export interface PlannerDeps {
  config: RunnerConfig;
  tasks: CandidateTask[];
  historyContext?: unknown;
  observe(): Promise<CandidateObservation>;
  executeCandidate(
    candidate: ActionCandidate,
    expectedStateVersion: string,
  ): Promise<PlannerExecution>;
  askOwner?(question: OwnerQuestion): Promise<void>;
  maxStateChanges?: number;
  delegatedSelection?: {
    candidateId: string;
    expectedStateVersion: string;
    fingerprint?: string;
  };
}

export interface PlannerResult {
  outcomes: TaskOutcome[];
  questions: OwnerQuestion[];
  actions: PlannerExecution[];
  planned: boolean;
  /** Carried out so the run can report why it stopped, not just that it did. */
  ownerBlockers: CandidateObservation["ownerBlockers"];
  fatalBlockers: CandidateObservation["fatalBlockers"];
  stopCode?: string;
}

const tools: AIToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "observe_run",
      description:
        "Read live balances, task analyses, safe candidates, and blockers.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_candidate",
      description:
        "Execute exactly one candidate returned by the latest observation.",
      parameters: {
        type: "object",
        properties: { candidateId: { type: "string" } },
        required: ["candidateId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_owner",
      description:
        "Pause for an owner-only decision or action when no safe candidate can resolve it.",
      parameters: {
        type: "object",
        properties: {
          candidateId: { type: "string" },
          question: { type: "string" },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
];

const systemPrompt = [
  "You operate a bounded Base-mainnet quest agent.",
  "Call observe_run before choosing an action.",
  "You may execute only a candidateId from the latest observation.",
  "Prefer quest actions that also unlock later tasks, then lower normalized cost.",
  "Never invent amounts, addresses, routes, calldata, tools, or candidate IDs.",
  "Execute one candidate at a time and observe again after every state change.",
  "Use ask_owner only when the observation has no safe candidate for an owner blocker.",
].join(" ");

function publicObservation(observation: CandidateObservation) {
  return {
    stateVersion: observation.stateVersion,
    blockNumber: observation.blockNumber,
    balances: observation.balances,
    candidates: observation.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      actionName: candidate.actionName,
      purpose: candidate.purpose,
      requirements: candidate.analysis.requirements,
      effects: candidate.analysis.effects,
      economics: candidate.analysis.economics,
      estimatedCostUsd: candidate.estimatedCostUsd,
      usefulEffects: candidate.usefulEffects,
      rank: candidate.rank,
      explanation: candidate.explanation,
      expiresAt: candidate.expiresAt,
    })),
    ownerBlockers: observation.ownerBlockers,
    fatalBlockers: observation.fatalBlockers,
  };
}

export async function planAndExecute(
  deps: PlannerDeps,
): Promise<PlannerResult> {
  const outcomes = new Map<string, TaskOutcome>();
  const questions: OwnerQuestion[] = [];
  const actions: PlannerExecution[] = [];
  let latest: CandidateObservation | null = null;
  let ownerBlockers: CandidateObservation["ownerBlockers"] = [];
  let fatalBlockers: CandidateObservation["fatalBlockers"] = [];
  let stopCode: string | undefined;
  let stopForOwner = false;
  const executedCandidateIds = new Set<string>();
  const maxStateChanges = deps.maxStateChanges ?? 1;
  /** Tool calls the planner refused: an invented tool, bad args, a stale id. */
  let refusals = 0;

  const observe = async () => {
    const observation = await deps.observe();
    ownerBlockers = observation.ownerBlockers;
    fatalBlockers = observation.fatalBlockers;
    return observation;
  };

  const executeOne = async (
    candidate: ActionCandidate,
    expectedStateVersion: string,
  ) => {
    const execution = await deps.executeCandidate(
      candidate,
      expectedStateVersion,
    );
    actions.push(execution);
    executedCandidateIds.add(candidate.candidateId);
    if (execution.result.status === "owner_required") {
      stopForOwner = true;
      const question = {
        question: execution.result.message,
        blockedTaskId:
          candidate.purpose.kind === "quest_task"
            ? candidate.purpose.taskId
            : candidate.purpose.forTaskId,
      };
      questions.push(question);
      await deps.askOwner?.(question);
    }
    if (execution.taskOutcome)
      outcomes.set(execution.taskOutcome.taskId, execution.taskOutcome);
    latest = null;
    return execution;
  };

  const result = (): PlannerResult => ({
    outcomes: [...outcomes.values()],
    questions,
    actions,
    planned: actions.length > 0 || questions.length > 0,
    ownerBlockers,
    fatalBlockers,
    stopCode,
  });

  if (deps.delegatedSelection) {
    const observation = await observe();
    latest = observation;
    if (observation.stateVersion !== deps.delegatedSelection.expectedStateVersion) {
      return { ...result(), stopCode: "DECISION_STALE" };
    }
    const selected = observation.candidates.find(
      (candidate) => candidate.candidateId === deps.delegatedSelection!.candidateId,
    );
    if (!selected) return { ...result(), stopCode: "CANDIDATE_INVALID" };
    if (selected.expiresAt && Date.parse(selected.expiresAt) <= Date.now()) {
      return { ...result(), stopCode: "DECISION_STALE" };
    }
    await executeOne(selected, observation.stateVersion);
    return result();
  }

  if (!process.env.OPENROUTER_API_KEY) {
    await observe();
    return { ...result(), stopCode: "PLANNER_SELECTION_REQUIRED" };
  }

  const messages: AIConversationMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Complete this run safely. Tasks: ${JSON.stringify(deps.tasks)} Historical context: ${JSON.stringify(deps.historyContext ?? null)}`,
    },
  ];

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const result = await chatCompletion({
      messages,
      model: deps.config.llmModel,
      fallbacks: deps.config.llmFallbackModels,
      tools,
      toolChoice: "required",
      parallelToolCalls: false,
      temperature: 0,
      maxTokens: 700,
      signal: AbortSignal.timeout(45_000),
    });
    // `finishReason` alone does not narrow the union: the text variant declares
    // it too, so the tool-call fields are only present behind an `in` check.
    if (
      !result.success ||
      !("toolCalls" in result) ||
      !("assistantMessage" in result) ||
      result.toolCalls.length === 0
    ) {
      stopCode = "PLANNER_UNAVAILABLE";
      break;
    }

    if (result.toolCalls.length !== 1) {
      refusals += 1;
      stopCode = "PLANNER_PROTOCOL_ERROR";
      break;
    }

    messages.push(result.assistantMessage);
    const call = result.toolCalls[0]!;
    let toolResult: unknown;
    if (call.function.name === "observe_run") {
      const observation = await observe();
      latest = observation;
      // Nothing runnable and nothing to ask about: further turns would only
      // re-observe, because tool use is required while the loop continues.
      if (
        observation.candidates.length === 0 &&
        observation.ownerBlockers.length === 0
      ) {
        break;
      }
      toolResult = { ok: true, observation: publicObservation(observation) };
    } else if (call.function.name === "execute_candidate") {
      const parsed = executeArgsSchema.safeParse(
        parseToolArguments(call.function.arguments),
      );
      if (!parsed.success || !latest) {
        refusals += 1;
        toolResult = {
          ok: false,
          code: latest ? "BAD_ARGUMENTS" : "OBSERVATION_REQUIRED",
        };
      } else {
        const observation = latest;
        const candidate = observation.candidates.find(
          (item) => item.candidateId === parsed.data.candidateId,
        );
        if (!candidate) {
          refusals += 1;
          toolResult = { ok: false, code: "UNKNOWN_CANDIDATE" };
        } else if (executedCandidateIds.has(candidate.candidateId)) {
          refusals += 1;
          toolResult = { ok: false, code: "CANDIDATE_ALREADY_EXECUTED" };
        } else {
          const execution = await executeOne(
            actionCandidateSchema.parse(candidate),
            observation.stateVersion,
          );
          toolResult = {
            ok: execution.result.status === "confirmed",
            result: actionResultSchema.parse(execution.result),
          };
          if (actions.length >= maxStateChanges) {
            stopCode = "CYCLE_BOUND_REACHED";
          }
        }
      }
    } else if (call.function.name === "ask_owner") {
      const parsed = ownerArgsSchema.safeParse(
        parseToolArguments(call.function.arguments),
      );
      if (!parsed.success || !latest || latest.candidates.length > 0) {
        refusals += 1;
        toolResult = { ok: false, code: "OWNER_QUESTION_NOT_ALLOWED" };
      } else {
        const blocker = latest.ownerBlockers[0];
        const question = {
          question: parsed.data.question,
          blockedTaskId: blocker?.taskId ?? null,
        };
        questions.push(question);
        await deps.askOwner?.(question);
        toolResult = { ok: true, recorded: true };
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(toolResult),
        });
        break;
      }
    } else {
      refusals += 1;
      toolResult = { ok: false, code: "UNKNOWN_TOOL" };
    }
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(toolResult),
    });
    if (stopForOwner || actions.length >= maxStateChanges) break;
  }

  return result();
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return null;
  }
}

export type PlannableTask = CandidateTask;
