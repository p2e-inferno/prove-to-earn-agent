import { paidFetch, type PaidFetchResult } from "./paid-fetch";
import { z } from "zod";
import type { AgentWallet } from "./wallet";
import type { RunnerConfig } from "./config";

/**
 * Self-renewing: the agent holds the signing key, so no human is involved
 * after registration. This is what makes the loop autonomous.
 */
export class AgentSession {
  private token: string | null = null;
  private expiresAtMs = 0;

  constructor(
    private readonly wallet: AgentWallet,
    private readonly config: RunnerConfig,
  ) {}

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
    this.expiresAtMs = Date.now() + session.data.data.expiresIn * 1000;
    return this.token;
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
    } = {},
  ): Promise<PaidFetchResult<T>> {
    try {
      const bearerToken = await this.bearer();
      return await paidFetch<T>(
        this.wallet,
        `${this.config.gatewayBaseUrl}${path}`,
        { ...options, bearerToken },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
      })
      .passthrough(),
  })
  .passthrough();
