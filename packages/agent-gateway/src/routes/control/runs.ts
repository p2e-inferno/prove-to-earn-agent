import { z } from "zod";
import {
  headlessDecisionSelectionV1Schema,
  rawAmountSchema,
} from "@p2e/agent-contracts";
import { createHeadlessControlRoute, controlJson } from "../../control/route";
import {
  cancelHeadlessRun,
  chooseHeadlessCandidate,
  getHeadlessRun,
  resolveHeadlessAdmission,
  resolveHeadlessRunDecision,
  startHeadlessRun,
} from "../../control/service";

const startSchema = z
  .object({ runId: z.string().uuid(), maxFeeRaw: rawAmountSchema })
  .strict();

export const START = createHeadlessControlRoute({
  scope: "quests:run",
  mutation: true,
  handler: async (req, _params, context) => {
    const parsed = startSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return controlJson({ ok: false, code: "INVALID_REQUEST" }, 400);
    return startHeadlessRun(context, {
      ...parsed.data,
      requestId: req.headers.get("idempotency-key")!,
    });
  },
});

export const GET = createHeadlessControlRoute({
  scope: "agent:read",
  handler: async (_req, params, context) => {
    if (!params.commandId) throw new Error("RUN_NOT_FOUND");
    return getHeadlessRun(context, params.commandId);
  },
});

const chooseSchema = headlessDecisionSelectionV1Schema;

export const CHOOSE = createHeadlessControlRoute({
  scope: "quests:decide",
  mutation: true,
  handler: async (req, params, context) => {
    if (!params.commandId) throw new Error("RUN_NOT_FOUND");
    const parsed = chooseSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return controlJson({ ok: false, code: "INVALID_REQUEST" }, 400);
    if ("frameId" in parsed.data) {
      return chooseHeadlessCandidate(context, {
        commandId: params.commandId,
        ...parsed.data,
      });
    }
    if ("decisionId" in parsed.data) {
      return resolveHeadlessRunDecision(context, {
        commandId: params.commandId,
        ...parsed.data,
      });
    }
    return resolveHeadlessAdmission(context, {
      commandId: params.commandId,
      ...parsed.data,
    });
  },
});

const cancelSchema = z.object({ expectedVersion: z.number().int().nonnegative() }).strict();

export const CANCEL = createHeadlessControlRoute({
  scope: "quests:cancel",
  mutation: true,
  handler: async (req, params, context) => {
    if (!params.commandId) throw new Error("RUN_NOT_FOUND");
    const parsed = cancelSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return controlJson({ ok: false, code: "INVALID_REQUEST" }, 400);
    return cancelHeadlessRun(context, { commandId: params.commandId, ...parsed.data });
  },
});
