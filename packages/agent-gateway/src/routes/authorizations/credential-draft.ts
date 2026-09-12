import { createCredentialRotationDraft } from "../../auth/headless-authorization";
import {
  createHeadlessOwnerRoute,
  headlessOwnerJson,
} from "../../auth/owner-headless-route";

export const POST = createHeadlessOwnerRoute(async (_req, params, context) => {
  if (!params.agentId) {
    return headlessOwnerJson({ error: "INVALID_REQUEST" }, 400);
  }
  const draft = await createCredentialRotationDraft({
    agentId: params.agentId,
    ownerUserId: context.ownerUserId,
    ownerWallet: context.ownerWallet,
  });
  return headlessOwnerJson({ credentialRotation: draft }, 201);
});
