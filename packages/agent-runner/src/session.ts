import {
  paidFetch,
  type PaidFetchResult,
  type WorldDiscountEligibility,
  type X402PaymentLifecycle,
} from "./paid-fetch";
import { z } from "zod";
import type { AgentWallet } from "./wallet";
import type { RunnerConfig } from "./config";

export class AgentSession {
  private token: string | null = null;
  private expiresAtMs = 0;
  private currentExecutionMode: "owner_invoked" | "scheduled" | null = null;
  private paymentRemainingRaw: bigint | null;
  private paymentLifecycle: X402PaymentLifecycle | undefined;

  constructor(
    private readonly wallet: AgentWallet,
    private readonly config: RunnerConfig,
  ) {
    this.paymentRemainingRaw = config.maxX402PerRunRaw
      ? BigInt(config.maxX402PerRunRaw)
      : null;
  }

  setPaymentLifecycle(lifecycle: X402PaymentLifecycle): void {
    this.paymentLifecycle = lifecycle;
  }

  private async fetchJson(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.config.gatewayBaseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json().catch(() => null);
  }

  async bearer(): Promise<string> {
    if (this.token && Date.now() < this.expiresAtMs - 30_000) {
      return this.token;
    }

    const challenge = sessionChallengeSchema.safeParse(
      await this.fetchJson("/api/agent/v1/session/challenge", {
        agentWallet: this.wallet.address,
      }),
    );
    if (!challenge.success) {
      throw new Error("Session challenge failed: malformed gateway response");
    }
    const { message, nonce } = challenge.data.data;

    const signature = await this.wallet.signMessage(message);

    const session = issuedSessionSchema.safeParse(
      await this.fetchJson("/api/agent/v1/session", {
        agentWallet: this.wallet.address,
        nonce,
        signature,
      }),
    );
    if (!session.success) {
      throw new Error("Session issuance failed: malformed gateway response");
    }

    this.token = session.data.data.token;
    this.currentExecutionMode = session.data.data.executionMode;
    this.expiresAtMs = Date.now() + session.data.data.expiresIn * 1000;
    return this.token;
  }

  async executionMode(): Promise<"owner_invoked" | "scheduled"> {
    await this.bearer();
    if (!this.currentExecutionMode) {
      throw new Error("Session did not identify the agent execution mode");
    }
    return this.currentExecutionMode;
  }

  /**
   * Never throws.
   *
   * A transport failure, an unreachable gateway or a rejected session must come
   * back as a result the run loop can narrate. Throwing here is what made the
   * agent die mid-job with the owner none the wiser.
   */
  async call<T>(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      idempotencyKey?: string;
      discountEligibility?: WorldDiscountEligibility;
    } = {},
  ): Promise<PaidFetchResult<T>> {
    try {
      const bearerToken = await this.bearer();
      const result = await paidFetch<T>(
        this.wallet,
        `${this.config.gatewayBaseUrl}${path}`,
        {
          ...options,
          bearerToken,
          paymentLifecycle: this.paymentLifecycle,
          ...(this.paymentRemainingRaw !== null
            ? { maxPaymentRaw: this.paymentRemainingRaw.toString() }
            : {}),
        },
      );
      if (result.paidAmountRaw && this.paymentRemainingRaw !== null) {
        this.paymentRemainingRaw =
          this.paymentRemainingRaw > BigInt(result.paidAmountRaw)
            ? this.paymentRemainingRaw - BigInt(result.paidAmountRaw)
            : 0n;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "X402_PAYMENT_REPLAY_BLOCKED") {
        return {
          status: 409,
          ok: false,
          code: "X402_PAYMENT_RECONCILIATION_REQUIRED",
          category: "payment",
          message:
            "A prior payment attempt is unresolved, so another payment was not signed.",
          retryable: false,
          paid: false,
          discounted: false,
        };
      }
      if (message === "budget_exceeded" || message === "action_denied") {
        return {
          status: 403,
          ok: false,
          code: "X402_PAYMENT_BUDGET_EXCEEDED",
          category: "payment",
          message: "The payment is outside the signed authorization policy.",
          retryable: false,
          paid: false,
          discounted: false,
        };
      }
      const unreachable =
        message.includes("fetch failed") ||
        message.includes("ECONNREFUSED") ||
        message.includes("ENOTFOUND");

      return {
        status: 0,
        ok: false,
        code: unreachable
          ? "GATEWAY_UNREACHABLE"
          : message.startsWith("Session")
            ? "SESSION_FAILED"
            : "TRANSPORT_ERROR",
        category: message.startsWith("Session")
          ? "authentication"
          : "transport",
        message: unreachable
          ? `Could not reach the P2E gateway at ${this.config.gatewayBaseUrl}.`
          : message,
        retryable: true,
        paid: false,
        discounted: false,
      };
    }
  }
}

const sessionChallengeSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({ message: z.string().min(1), nonce: z.string().min(1) })
      .passthrough(),
  })
  .passthrough();

const issuedSessionSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        token: z.string().min(1),
        expiresIn: z.number().int().positive().default(900),
        executionMode: z
          .enum(["owner_invoked", "scheduled"])
          .default("scheduled"),
      })
      .passthrough(),
  })
  .passthrough();
