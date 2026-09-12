import { z } from "zod";
import { createAuthorizationDraft } from "../../auth/headless-authorization";
import {
  createHeadlessOwnerRoute,
  headlessOwnerJson,
} from "../../auth/owner-headless-route";

const draftSchema = z
  .object({
    policy: z.record(z.unknown()).optional().default({}),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export const POST = createHeadlessOwnerRoute(
  async (req, params, context) => {
    if (!params.agentId) {
      return headlessOwnerJson({ error: "INVALID_REQUEST" }, 400);
    }
    const parsed = draftSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return headlessOwnerJson({ error: "INVALID_POLICY" }, 400);
    }
    const draft = await createAuthorizationDraft({
      agentId: params.agentId,
      ownerUserId: context.ownerUserId,
      ownerWallet: context.ownerWallet,
      policy: parsed.data.policy,
      expiresAt: parsed.data.expiresAt,
    });
    return headlessOwnerJson({ authorization: draft }, 201);
  },
);
