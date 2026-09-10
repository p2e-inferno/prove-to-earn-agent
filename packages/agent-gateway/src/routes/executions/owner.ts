import { NextResponse, type NextRequest } from "next/server";
import { inngest } from "@/lib/inngest/client";
import { appendAgentReply } from "@/lib/agent-chat/server/store";
import {
  listOwnerAgentExecutions,
  resolveOwnerAgentDecision,
} from "@/lib/quests/daily-quests/services/agent-execution";
import { agentError, toEnvelope } from "../../errors";
import { createPairingRoute } from "../../route-factory";

export const GET = createPairingRoute({
  guard: "owner-privy-session",
  handler: async (_req, params, ownerUserId) => {
    if (!ownerUserId)
      return agentError(401, "OWNER_AUTH_REQUIRED", "Sign in required");
    if (!params.agentId)
      return agentError(400, "INVALID_REQUEST", "Missing agentId");
    const result = await listOwnerAgentExecutions(ownerUserId, params.agentId);
    const { status, envelope } = toEnvelope(result.status, result.body);
    return NextResponse.json(envelope, { status });
  },
});

export const POST = createPairingRoute({
  guard: "owner-privy-session",
  handler: async (req: NextRequest, params, ownerUserId) => {
    if (!ownerUserId)
      return agentError(401, "OWNER_AUTH_REQUIRED", "Sign in required");
    if (!params.agentId)
      return agentError(400, "INVALID_REQUEST", "Missing agentId");
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return agentError(400, "INVALID_REQUEST", "A JSON body is required");
    }
    const result = await resolveOwnerAgentDecision(
      ownerUserId,
      params.agentId,
      body,
    );
    if (result.status < 300) {
      const executionId =
        body &&
        typeof body === "object" &&
        typeof (body as { executionId?: unknown }).executionId === "string"
          ? (body as { executionId: string }).executionId
          : null;
      if (executionId) {
        const resolution =
          body && typeof body === "object"
            ? (body as { resolution?: unknown }).resolution
            : null;
        const decision = (result.body as { decision?: Record<string, unknown> })
          .decision;
        const commandId =
          typeof decision?.command_id === "string" ? decision.command_id : null;
        const stateVersion = Number(decision?.execution_state_version);
        if (commandId && Number.isInteger(stateVersion)) {
          if (resolution === "cancel") {
            await appendAgentReply({
              agentId: params.agentId,
              ownerUserId,
              executionId,
              content: "I cancelled the owner-authorized quest run.",
              source: "execution",
            });
          } else {
            await inngest.send({
              id: `agent-execution-decision-${commandId}-${stateVersion}`,
              name: "agent/execution.continue",
              data: {
                agentId: params.agentId,
                executionId,
                expectedVersion: stateVersion,
              },
            });
          }
        }
      }
    }
    const { status, envelope } = toEnvelope(result.status, result.body);
    return NextResponse.json(envelope, { status });
  },
});
