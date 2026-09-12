import { base } from "viem/chains";
import { createPublicClientForNetwork } from "@vendor/blockchain/public-client";
import { describeQuestAvailability } from "@vendor/agent-chat/executable-quests";
import { ok, fail } from "@vendor/quests/principal";
import {
  assessAdmission,
  blockedAdmission,
} from "@/packages/agent-runner/src/admission";
import { loadPlatformConfig } from "@/packages/agent-runner/src/config";
import { templateIdForRun } from "../../db/agents";
import { createAgentRoute } from "../../route-factory";

export const GET = createAgentRoute({
  routeId: "quests.assessment",
  resolveTemplateId: async ({ params }) =>
    params.runId ? templateIdForRun(params.runId) : null,
  handler: async (ctx) => {
    const runId = ctx.params.runId;
    if (!runId) return fail(400, "INVALID_REQUEST", "Missing runId");
    const availability = await describeQuestAvailability(ctx.principal);
    const run = availability.executable.find(
      (candidate) => candidate.id === runId,
    );
    if (!run) {
      const reason =
        availability.blocked.find((candidate) => candidate.runId === runId) ??
        availability.blocked[0];
      return ok({
        assessment: blockedAdmission(ctx.principal.executionWallet, {
          code: reason?.code ?? "QUEST_UNAVAILABLE",
          message:
            reason?.message ?? "This quest is not available to the agent.",
          ...(reason?.taskId ? { taskId: reason.taskId } : {}),
        }),
      });
    }

    const config = loadPlatformConfig({
      providerAccountName:
        ctx.actor.agent.providerAccountName ?? `read-${ctx.actor.agent.id}`,
      maxFundingSwaps: ctx.actor.agent.maxFundingSwaps,
    });
    const assessment = await assessAdmission(
      {
        address: ctx.principal.executionWallet as `0x${string}`,
        caip2: `eip155:${base.id}`,
        publicClient: createPublicClientForNetwork({ chainId: base.id }),
      },
      config,
      run,
    );
    return ok({ assessment });
  },
});
