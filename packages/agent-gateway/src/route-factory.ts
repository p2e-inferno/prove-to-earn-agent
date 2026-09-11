import { AsyncLocalStorage } from "async_hooks";
import { NextResponse, type NextRequest } from "next/server";
import { withX402FromHTTPServer } from "@x402/next";
import type { QuestPrincipal, ServiceResult } from "@/lib/quests/principal";
import { getLogger } from "@/lib/utils/logger";
import { resolveAgentActor, type AgentActor } from "./auth/actor-auth";
import { hasCapability } from "./db/agents";
import {
  acquireRequest,
  hashRequest,
  markState,
  peekRequest,
  type RequestIdentity,
} from "./db/idempotency";
import { agentError, toEnvelope, type AgentEnvelope } from "./errors";
import { getHttpResourceServer } from "./payments/x402";
import { routeSpec } from "./payments/pricing";
import {
  isRecord,
  isValidIdempotencyKey,
  MAX_AGENT_BODY_BYTES,
} from "./validation";

const log = getLogger("agent-gateway:route-factory");

export interface AgentRouteContext {
  actor: AgentActor;
  principal: QuestPrincipal;
  params: Record<string, string>;
  body: unknown;
  identity: RequestIdentity | null;
  requestRef: { current: { id: string; attemptToken: string } | null };
}

type AgentHandler = (ctx: AgentRouteContext) => Promise<ServiceResult>;

/**
 * Carries the already-resolved actor into the x402-wrapped handler.
 *
 * withX402 verifies payment before it calls the wrapped function, so
 * authentication has to happen outside it — otherwise an agent with no
 * permission would be charged for the refusal.
 */
const routeStore = new AsyncLocalStorage<AgentRouteContext>();

function requireContext(): AgentRouteContext {
  const ctx = routeStore.getStore();
  if (!ctx) throw new Error("Agent route context is unavailable");
  return ctx;
}

async function readJsonBody(
  req: NextRequest,
): Promise<
  | { ok: true; body: unknown }
  | { ok: false; status: 400 | 413; message: string }
> {
  if (req.method === "GET" || req.method === "HEAD") {
    return { ok: true, body: null };
  }

  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_AGENT_BODY_BYTES
  ) {
    return { ok: false, status: 413, message: "Request body is too large" };
  }

  try {
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_AGENT_BODY_BYTES) {
      return { ok: false, status: 413, message: "Request body is too large" };
    }
    // A parameterless mutation sends no body at all — quests/start and
    // quests/complete carry everything in the path — so an empty one is the
    // empty object, not a malformed request.
    if (raw.trim() === "") return { ok: true, body: {} };
    const body = JSON.parse(raw) as unknown;
    if (!isRecord(body)) {
      return { ok: false, status: 400, message: "A JSON object is required" };
    }
    return { ok: true, body };
  } catch {
    return { ok: false, status: 400, message: "A valid JSON body is required" };
  }
}

function cachedResponse(
  body: unknown,
  status: number | null,
): NextResponse<AgentEnvelope> {
  return NextResponse.json<AgentEnvelope>(
    (body ?? { ok: true, data: null }) as AgentEnvelope,
    { status: status ?? 200 },
  );
}

/** Settlement metadata, for reconciliation and billing audit. */
function settlementFromHeaders(res: NextResponse): {
  paymentId: string | null;
  payer: string | null;
} {
  const raw =
    res.headers.get("PAYMENT-RESPONSE") ??
    res.headers.get("X-PAYMENT-RESPONSE");
  if (!raw) return { paymentId: null, payer: null };
  try {
    const decoded = JSON.parse(
      Buffer.from(raw, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    return {
      paymentId:
        typeof decoded.transaction === "string"
          ? decoded.transaction
          : typeof decoded.txHash === "string"
            ? decoded.txHash
            : null,
      payer: typeof decoded.payer === "string" ? decoded.payer : null,
    };
  } catch {
    return { paymentId: null, payer: null };
  }
}

export interface CreateAgentRouteOptions {
  routeId: string;
  idempotency?: boolean;
  handler: AgentHandler;
  /**
   * Template the capability is scoped against, when the route carries one.
   * Resolved after auth and before payment so a scope denial is never charged.
   */
  resolveTemplateId?: (ctx: {
    params: Record<string, string>;
    body: unknown;
    principal: QuestPrincipal;
  }) => Promise<string | null>;
}

/**
 * The single way to mount a protected agent route.
 *
 * Order is fixed here so it cannot be forgotten at a call site:
 *   auth -> capability -> settled-replay peek -> x402 verify
 *   -> acquire -> effect -> settle -> complete
 *
 * The peek is read-only and the acquire happens *inside* the paywall. Reserving
 * before payment would mark the key in flight during the mandatory 402
 * challenge, and the agent's paid retry would then collide with its own
 * reservation.
 */
export function createAgentRoute(options: CreateAgentRouteOptions) {
  const spec = routeSpec(options.routeId);
  if (options.idempotency === false && spec.tier !== "free")
    throw new Error("Paid mutations require idempotency");
  const isMutation = spec.method !== "GET";
  const isFree = spec.tier === "free";
  const requiresIdempotency = isMutation || !isFree;

  // Built on first request: Next collects route config at build time, and
  // resolving payment env vars there would fail the build without them.
  let paidHandler: ReturnType<
    typeof withX402FromHTTPServer<AgentEnvelope>
  > | null = null;

  const runInner = async (
    _req: NextRequest,
  ): Promise<NextResponse<AgentEnvelope>> => {
    const ctx = requireContext();

    if (ctx.identity) {
      let acquisition;
      try {
        acquisition = await acquireRequest(ctx.identity);
      } catch (error) {
        log.error("Idempotency acquisition failed", {
          routeId: options.routeId,
          error,
        });
        return agentError(
          503,
          "IDEMPOTENCY_UNAVAILABLE",
          "Could not acquire the request lease. Retry with the same key.",
        );
      }

      if (acquisition.outcome === "conflict") {
        return agentError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This Idempotency-Key was already used with a different request",
        );
      }
      if (acquisition.outcome === "in_flight") {
        return agentError(
          409,
          "IDEMPOTENCY_IN_FLIGHT",
          "An identical request is still in flight",
        );
      }
      if (acquisition.outcome === "replay") {
        if (!acquisition.attemptToken) {
          return agentError(
            503,
            "IDEMPOTENCY_UNAVAILABLE",
            "The committed request could not be reconciled. Retry shortly.",
          );
        }
        ctx.requestRef.current = {
          id: acquisition.id,
          attemptToken: acquisition.attemptToken,
        };
        return cachedResponse(
          acquisition.responseBody,
          acquisition.responseStatus,
        );
      }

      ctx.requestRef.current = {
        id: acquisition.id,
        attemptToken: acquisition.attemptToken,
      };
    }

    let result: ServiceResult;
    try {
      result = await options.handler(ctx);
    } catch (error) {
      log.error("Agent handler threw", {
        routeId: options.routeId,
        error,
      });
      if (ctx.requestRef.current) {
        await markState(
          ctx.requestRef.current.id,
          ctx.requestRef.current.attemptToken,
          "failed",
          { responseStatus: 500, clearLease: true },
        );
      }
      return agentError(500, "INTERNAL_ERROR", "Internal server error");
    }

    const { status, envelope } = toEnvelope(result.status, result.body);

    // Recorded before the response leaves: settlement runs after this
    // point, and a settle failure must not look like an unexecuted request.
    if (ctx.requestRef.current) {
      const nextState =
        status >= 200 && status < 300
          ? "effect_committed"
          : status >= 500
            ? "in_flight"
            : "failed";
      const stateUpdated = await markState(
        ctx.requestRef.current.id,
        ctx.requestRef.current.attemptToken,
        nextState,
        {
          responseStatus: status,
          responseBody: envelope,
          price: spec.tier,
          clearLease: true,
        },
      );
      if (!stateUpdated) {
        return agentError(
          409,
          "IDEMPOTENCY_LEASE_LOST",
          "This request was superseded by a retry. Reuse the same key.",
        );
      }
    }

    return NextResponse.json<AgentEnvelope>(envelope, { status });
  };

  const buildPaid = () =>
    withX402FromHTTPServer<AgentEnvelope>(
      runInner,
      getHttpResourceServer(options.routeId),
    );

  // A free route runs the same inner handler without the paywall, so its
  // idempotency and error behaviour stay identical to a priced one.
  const unpaid = async (req: NextRequest) => runInner(req);
  const paid = () => (isFree ? unpaid : (paidHandler ??= buildPaid()));

  return async function agentRoute(
    req: NextRequest,
    routeCtx?: {
      params?: Promise<Record<string, string>> | Record<string, string>;
    },
  ): Promise<NextResponse> {
    const resolution = await resolveAgentActor(req);
    if (!resolution.ok) {
      return agentError(resolution.status, resolution.code, resolution.message);
    }

    const actor = resolution.actor;
    const rawParams = routeCtx?.params;
    const params = rawParams ? await rawParams : {};
    const parsedBody = await readJsonBody(req);
    if (!parsedBody.ok) {
      return agentError(
        parsedBody.status,
        "INVALID_REQUEST",
        parsedBody.message,
      );
    }
    const body = parsedBody.body;

    let templateId: string | null = null;
    if (options.resolveTemplateId) {
      try {
        templateId = await options.resolveTemplateId({
          params,
          body,
          principal: actor.principal,
        });
      } catch (error) {
        log.error("Failed to resolve template scope", {
          routeId: options.routeId,
          error,
        });
        return agentError(500, "INTERNAL_ERROR", "Failed to resolve scope");
      }
    }

    if (
      spec.capability !== null &&
      !hasCapability(actor.permissions, spec.capability, templateId)
    ) {
      return agentError(
        403,
        "AGENT_CAPABILITY_DENIED",
        `This agent has no '${spec.capability}' permission for this resource`,
      );
    }

    let identity: RequestIdentity | null = null;

    if (requiresIdempotency && options.idempotency !== false) {
      const idempotencyKey = req.headers.get("idempotency-key");
      if (!isValidIdempotencyKey(idempotencyKey)) {
        return agentError(
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          "A non-empty Idempotency-Key of at most 200 characters is required",
        );
      }

      identity = {
        agentId: actor.agent.id,
        ownerUserId: actor.agent.ownerUserId,
        idempotencyKey,
        method: spec.method,
        route: options.routeId,
        pathname: req.nextUrl.pathname,
        body,
      };

      // A settled request replays outside the paywall: charging twice for one
      // effect is the failure this whole ledger exists to prevent.
      const peek = await peekRequest(identity);
      if (
        peek.outcome === "found" &&
        peek.requestHash !== hashRequest(identity)
      ) {
        return agentError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This Idempotency-Key was already used with a different request",
        );
      }
      if (
        peek.outcome === "found" &&
        (peek.state === "completed" || peek.state === "failed")
      ) {
        return cachedResponse(peek.responseBody, peek.responseStatus);
      }
    }

    const ctx: AgentRouteContext = {
      actor,
      principal: actor.principal,
      params,
      body,
      identity,
      requestRef: { current: null },
    };

    const response = await routeStore.run(ctx, () => paid()(req));

    // Only a delivered 2xx is complete: withX402 withholds the body when
    // settlement fails, and that request stays retryable at effect_committed.
    if (
      ctx.requestRef.current &&
      response.status >= 200 &&
      response.status < 300
    ) {
      const settlement = settlementFromHeaders(response);
      await markState(
        ctx.requestRef.current.id,
        ctx.requestRef.current.attemptToken,
        "completed",
        {
          responseStatus: response.status,
          paymentId: settlement.paymentId,
          payer: settlement.payer ?? actor.agent.agentWallet,
          clearLease: true,
        },
      );
    }

    return response;
  };
}

/**
 * Mount an unpriced pairing route.
 *
 * These run before an agent record exists, so they cannot carry an agent
 * session — but they are not unauthenticated. The declared guard is executed
 * here, not merely labelled, so a handler cannot forget to apply it.
 */
export function createPairingRoute(options: {
  /**
   * What authenticates this route. Only `owner-privy-session` is enforced
   * here; the signature guards name a proof the handler itself verifies,
   * because what is signed differs per route. `check-agent-guards` asserts the
   * declaration matches the code, so the label cannot drift from the check.
   */
  guard:
    | "owner-privy-session"
    | "admin-session"
    | "agent-wallet-signature"
    | "owner-or-agent-signature"
    | "public";
  handler: (
    req: NextRequest,
    params: Record<string, string>,
    ownerUserId: string | null,
  ) => Promise<NextResponse>;
}) {
  return async function pairingRoute(
    req: NextRequest,
    routeCtx?: {
      params?: Promise<Record<string, string>> | Record<string, string>;
    },
  ): Promise<NextResponse> {
    const rawParams = routeCtx?.params;
    const params = rawParams ? await rawParams : {};

    let ownerUserId: string | null = null;

    if (options.guard === "admin-session") {
      const { ensureAdminOrRespond } =
        await import("@/lib/auth/route-handlers/admin-guard");
      const denied = await ensureAdminOrRespond(req);
      if (denied) return denied;
    }

    if (options.guard === "owner-privy-session") {
      const { getPrivyUserFromNextRequest } = await import("@/lib/auth/privy");
      const user = await getPrivyUserFromNextRequest(req);
      if (!user?.id && options.guard === "owner-privy-session") {
        return agentError(
          401,
          "OWNER_AUTH_REQUIRED",
          "Owner authentication is required",
        );
      }
      ownerUserId = user?.id ?? null;
    }

    try {
      return await options.handler(req, params, ownerUserId);
    } catch (error) {
      log.error("Pairing route threw", { guard: options.guard, error });
      return agentError(500, "INTERNAL_ERROR", "Internal server error");
    }
  };
}
