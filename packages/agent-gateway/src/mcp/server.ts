import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  headlessDecisionSelectionV1Schema,
  rawAmountSchema,
} from "@p2e/agent-contracts";
import type { HeadlessControlContext } from "../control/service";
import {
  assessHeadlessQuest,
  cancelHeadlessRun,
  chooseHeadlessCandidate,
  getHeadlessConfig,
  getHeadlessRun,
  getHeadlessUsage,
  listHeadlessQuests,
  resolveHeadlessAdmission,
  resolveHeadlessRunDecision,
  startHeadlessRun,
} from "../control/service";

function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: { result: data },
  };
}

function toolFailure(error: unknown) {
  const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, code }) }],
    structuredContent: { result: { ok: false, code } },
    isError: true,
  };
}

function guarded<T>(operation: () => Promise<T>) {
  return operation().then(toolResult).catch(toolFailure);
}

function requireScope<T>(
  context: HeadlessControlContext,
  scope: string,
  operation: () => Promise<T>,
) {
  if (!context.scopes.includes(scope)) {
    return Promise.resolve(toolFailure(new Error("INSUFFICIENT_SCOPE")));
  }
  return guarded(operation);
}

export function createHeadlessMcpServer(context: HeadlessControlContext) {
  const server = new McpServer({
    name: "p2e-inferno-agent",
    version: "1.0.0",
  });

  server.registerTool(
    "agent_get_config",
    {
      description: "Read this agent's immutable authorization and current limits.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => requireScope(context, "agent:read", () => getHeadlessConfig(context)),
  );

  server.registerTool(
    "quest_list",
    {
      description: "List currently available quests allowed by the signed policy.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => requireScope(context, "quests:read", () => listHeadlessQuests(context)),
  );

  server.registerTool(
    "quest_assess",
    {
      description: "Assess one quest without starting it or spending task funds.",
      inputSchema: {
        runId: z.string().uuid(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) =>
      requireScope(context, "quests:read", () => assessHeadlessQuest(context, runId)),
  );

  server.registerTool(
    "quest_start",
    {
      description: "Create a durable quest command; returns immediately for status polling.",
      inputSchema: {
        runId: z.string().uuid(),
        requestId: z.string().min(1).max(200),
        maxFeeRaw: rawAmountSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (input) => requireScope(context, "quests:run", () => startHeadlessRun(context, input)),
  );

  server.registerTool(
    "quest_status",
    {
      description: "Read command progress and any current decision frame.",
      inputSchema: { commandId: z.string().uuid() },
      annotations: { readOnlyHint: true },
    },
    async ({ commandId }) =>
      requireScope(context, "agent:read", () => getHeadlessRun(context, commandId)),
  );

  server.registerTool(
    "quest_choose",
    {
      description: "Choose exactly one server-issued candidate from the current frame.",
      inputSchema: {
        commandId: z.string().uuid(),
        requestId: z.string().min(1).max(200),
        decision: headlessDecisionSelectionV1Schema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ commandId, decision }) =>
      requireScope(context, "quests:decide", () => {
        if ("frameId" in decision) {
          return chooseHeadlessCandidate(context, { commandId, ...decision });
        }
        if ("decisionId" in decision) {
          return resolveHeadlessRunDecision(context, {
            commandId,
            ...decision,
          });
        }
        return resolveHeadlessAdmission(context, { commandId, ...decision });
      }),
  );

  server.registerTool(
    "quest_cancel",
    {
      description: "Cancel a headless command that has not reached a terminal state.",
      inputSchema: {
        commandId: z.string().uuid(),
        requestId: z.string().min(1).max(200),
        expectedVersion: z.number().int().nonnegative(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ commandId, expectedVersion }) =>
      requireScope(context, "quests:cancel", () =>
        cancelHeadlessRun(context, { commandId, expectedVersion }),
      ),
  );

  server.registerTool(
    "agent_get_usage",
    {
      description: "Read the last 24 hours of reserved and reconciled usage.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => requireScope(context, "agent:read", () => getHeadlessUsage(context)),
  );

  return server;
}
