import { randomUUID } from "crypto";
import { z } from "zod";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { AGENTKIT, type AgentkitExtension } from "@worldcoin/agentkit-core";
import { createAgentkitClient } from "@worldcoin/agentkit";
import type { AgentWallet } from "./wallet";

export interface PaidFetchOptions {
  method?: "GET" | "POST";
  body?: unknown;
  idempotencyKey?: string;
  bearerToken?: string;
}

export interface PaidFetchResult<T = unknown> {
  status: number;
  ok: boolean;
  code?: string;
  message?: string;
  retryable?: boolean;
  data?: T;
  intent?: unknown;
  paid: boolean;
  discounted: boolean;
}

/** The server stamps its mode onto the declaration it sends with each 402. */
type AgentkitMode =
  | { type: "free" }
  | { type: "free-trial"; uses?: number }
  | { type: "discount"; percent: number; uses?: number };

type QuotedExtension = AgentkitExtension & { mode?: AgentkitMode };

type PaymentRequired = ReturnType<x402HTTPClient["getPaymentRequiredResponse"]>;

let cachedHttpClient: x402HTTPClient | null = null;
let cachedWalletAddress: string | null = null;

/**
 * Official v2 client rather than a hand-rolled wire format.
 *
 * x402 v2 negotiates over `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` /
 * `PAYMENT-RESPONSE`; reproducing that by hand (and sending v1's `X-PAYMENT`)
 * silently fails against a v2 resource server.
 */
function httpClient(wallet: AgentWallet): x402HTTPClient {
  if (cachedHttpClient && cachedWalletAddress === wallet.address) {
    return cachedHttpClient;
  }
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: wallet.x402Signer as never });
  cachedHttpClient = new x402HTTPClient(client);
  cachedWalletAddress = wallet.address;
  return cachedHttpClient;
}

function agentkitClientFor(wallet: AgentWallet) {
  return createAgentkitClient({
    signer: {
      // 'evm' is not a valid signer type; the library accepts eip191 (EOA
      // personal_sign) or eip1271 (contract signature), and requires chainId.
      type: "eip191",
      chainId: wallet.caip2,
      address: wallet.address,
      signMessage: (message: string) => wallet.signMessage(message),
    },
  });
}

function baseHeaders(options: PaidFetchOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.bearerToken) {
    headers.authorization = `Bearer ${options.bearerToken}`;
  }
  if ((options.method ?? "GET") !== "GET") {
    // Stable across every retry in this call: the gateway keys the effect on
    // it, so the paid retry settles the original rather than running twice.
    headers["idempotency-key"] = options.idempotencyKey ?? randomUUID();
  }
  return headers;
}

function readAgentkitExtension(
  paymentRequired: PaymentRequired,
): QuotedExtension | null {
  const extension = (
    paymentRequired as unknown as {
      extensions?: Record<string, QuotedExtension>;
    }
  )?.extensions?.[AGENTKIT];
  return extension?.info ? extension : null;
}

/**
 * Apply the declared discount to every quoted requirement.
 *
 * The server never re-quotes: in discount mode AgentKit's request hook only
 * records that this human is entitled, then lets verification fail on the
 * short payment and recovers it in `onVerifyFailure`. So computing the reduced
 * amount is the client's job, and it must match the server's arithmetic
 * exactly — same BigInt floor division, or the payment reads as underpaid and
 * is refused outright.
 */
export function applyDiscount(
  paymentRequired: PaymentRequired,
  percent: number,
): PaymentRequired | null {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) return null;

  const accepts = paymentRequired.accepts ?? [];
  if (accepts.length === 0) return null;

  const discountedAccepts = accepts.map((requirement) => {
    const full = BigInt(requirement.amount);
    const discounted = (full * BigInt(100 - percent)) / 100n;
    return { ...requirement, amount: String(discounted) };
  });

  // A zero quote cannot be paid, and the server rejects anything at or above
  // full price as "not actually discounted".
  if (
    discountedAccepts.some((r, i) => {
      const discounted = BigInt(r.amount);
      return discounted <= 0n || discounted >= BigInt(accepts[i]!.amount);
    })
  ) {
    return null;
  }

  return { ...paymentRequired, accepts: discountedAccepts };
}

/**
 * Fetch a priced gateway endpoint, negotiating the World identity discount and
 * the x402 payment.
 *
 * `createAgentkitClient` signs the World challenge but explicitly does not
 * create payments, and the generic x402 client knows nothing about the
 * discount, so the combination is composed here.
 *
 * The identity header and the payment travel in the *same* request. The
 * server's protected-request hook runs before payment verification on every
 * call, so that one request both proves the human and pays; probing first would
 * spend the challenge nonce, which the gateway records as used, and leave the
 * paying request unidentified and charged in full.
 */
export async function paidFetch<T = unknown>(
  wallet: AgentWallet,
  url: string,
  options: PaidFetchOptions = {},
): Promise<PaidFetchResult<T>> {
  const method = options.method ?? "GET";
  const headers = baseHeaders(options);
  const init: RequestInit = {
    method,
    headers,
    ...(method !== "GET" && options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  };

  const http = httpClient(wallet);

  const response = await fetch(url, init);
  if (response.status !== 402) {
    return toResult<T>(response, false, false);
  }

  const readQuote = async (res: Response): Promise<PaymentRequired> => {
    const body = await res
      .clone()
      .json()
      .catch(() => null);
    return http.getPaymentRequiredResponse(
      (name) => res.headers.get(name),
      body,
    );
  };

  let paymentRequired = await readQuote(response);
  const extension = readAgentkitExtension(paymentRequired);
  const mode = extension?.mode;

  // 'free' and 'free-trial' are granted by the identity header alone: the hook
  // short-circuits the paywall, so sending a payment would overpay for access
  // already given.
  if (extension && (mode?.type === "free" || mode?.type === "free-trial")) {
    try {
      const granted = await fetch(url, {
        ...init,
        headers: {
          ...headers,
          [AGENTKIT]: await agentkitClientFor(wallet).createHeader(extension),
        },
      });
      if (granted.status !== 402) {
        return toResult<T>(granted, false, true);
      }
      // Trial exhausted. That challenge is spent, so pay against the fresh
      // quote without an identity header rather than replaying a used nonce.
      paymentRequired = await readQuote(granted);
    } catch {
      // A World failure must never block payment: fall through at full price.
    }
  }

  if (extension && mode?.type === "discount") {
    const discountedQuote = applyDiscount(paymentRequired, mode.percent);
    if (discountedQuote) {
      try {
        const identityHeader =
          await agentkitClientFor(wallet).createHeader(extension);
        const payload = await http.createPaymentPayload(discountedQuote);

        const discountedResponse = await fetch(url, {
          ...init,
          headers: {
            ...headers,
            [AGENTKIT]: identityHeader,
            ...http.encodePaymentSignatureHeader(payload),
          },
        });

        // Only a non-402 proves the underpayment was recovered. A 402 means the
        // discount was refused (allowance spent, agent not in AgentBook), and
        // the short payment was never settled — so retry at full price.
        if (discountedResponse.status !== 402) {
          return toResult<T>(discountedResponse, true, true);
        }
        paymentRequired = await readQuote(discountedResponse);
      } catch {
        // Fall through and pay in full.
      }
    }
  }

  const payload = await http.createPaymentPayload(paymentRequired);
  const paidResponse = await fetch(url, {
    ...init,
    headers: { ...headers, ...http.encodePaymentSignatureHeader(payload) },
  });
  return toResult<T>(paidResponse, true, false);
}

async function toResult<T>(
  response: Response,
  paid: boolean,
  discounted: boolean,
): Promise<PaidFetchResult<T>> {
  const body = responseEnvelopeSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!body.success) {
    return {
      status: response.status,
      ok: false,
      code: "INVALID_RESPONSE",
      message: "The server returned a malformed JSON response.",
      retryable: response.status >= 500,
      paid,
      discounted,
    };
  }
  return {
    status: response.status,
    ok: body.data.ok === true,
    code: body.data.code,
    message: body.data.message,
    retryable: body.data.retryable === true,
    data: (body.data.data ?? undefined) as T | undefined,
    intent: body.data.intent ?? null,
    paid,
    discounted,
  };
}

const responseEnvelopeSchema = z
  .object({
    ok: z.boolean().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    retryable: z.boolean().optional(),
    data: z.unknown().optional(),
    intent: z.unknown().optional(),
  })
  .passthrough();
