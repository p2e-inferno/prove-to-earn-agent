import { createHash } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { rateLimiter } from "@vendor/agent-rate-limiter";
import { verifyHeadlessCredential } from "../../auth/headless-authorization";
import { issueHeadlessAccessToken } from "../../auth/headless-session";
import { headlessAgentAuthEnabled, headlessAgentResource } from "../../env";

function oauthError(error: string, description: string, status: number) {
  const response = NextResponse.json(
    { error, error_description: description },
    { status },
  );
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  return response;
}

function readBasic(
  req: NextRequest,
): { clientId: string; clientSecret: string } | null {
  const header = req.headers.get("authorization");
  const match = header ? /^Basic ([A-Za-z0-9+/=]+)$/.exec(header) : null;
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator <= 0) return null;
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (!headlessAgentAuthEnabled())
    return oauthError("invalid_request", "Not found", 404);
  const basic = readBasic(req);
  if (
    !basic ||
    basic.clientSecret.length > 512 ||
    basic.clientId.length > 200
  ) {
    return oauthError("invalid_client", "Client authentication failed", 401);
  }
  const identityHash = createHash("sha256")
    .update(basic.clientId)
    .digest("hex");
  const limit = await rateLimiter.check(
    `headless-token:${identityHash}`,
    20,
    60_000,
  );
  if (limit.unavailable) {
    return oauthError("temporarily_unavailable", "Try again shortly", 503);
  }
  if (!limit.success) {
    return oauthError("slow_down", "Too many token requests", 429);
  }

  const mediaType = req.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (mediaType !== "application/x-www-form-urlencoded") {
    return oauthError("invalid_request", "Form encoding is required", 400);
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > 4096) {
    return oauthError("invalid_request", "Request is too large", 413);
  }
  const form = new URLSearchParams(raw);
  if (form.get("grant_type") !== "client_credentials") {
    return oauthError(
      "unsupported_grant_type",
      "Only client_credentials is supported",
      400,
    );
  }
  if (form.get("resource") !== headlessAgentResource()) {
    return oauthError(
      "invalid_target",
      "The canonical resource is required",
      400,
    );
  }

  const verified = await verifyHeadlessCredential(
    basic.clientId,
    basic.clientSecret,
  );
  if (!verified) {
    return oauthError("invalid_client", "Client authentication failed", 401);
  }
  const requestedScopes = (form.get("scope") ?? "").split(" ").filter(Boolean);
  const allowedScopes = verified.credential.scopes;
  if (requestedScopes.some((scope) => !allowedScopes.includes(scope))) {
    return oauthError(
      "invalid_scope",
      "A requested scope is not authorized",
      400,
    );
  }
  const scopes = requestedScopes.length ? requestedScopes : allowedScopes;
  const access = await issueHeadlessAccessToken({
    agentId: verified.agent.id,
    authorizationId: verified.authorization.id,
    credentialId: verified.credential.id,
    clientId: verified.credential.client_id,
    scopes,
  });
  const response = NextResponse.json({
    access_token: access.token,
    token_type: "Bearer",
    expires_in: access.expiresIn,
    scope: scopes.join(" "),
  });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  return response;
}
