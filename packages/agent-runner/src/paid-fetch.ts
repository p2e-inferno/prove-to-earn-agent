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
  maxPaymentRaw?: string;
  paymentLifecycle?: X402PaymentLifecycle;
}

export interface X402PaymentLifecycle {
  beforePayment(input: {
    url: string;
    idempotencyKey: string;
    phase: "discount" | "full";
    amountRaw: string;
  }): Promise<{ reservationId: string }>;
  paymentResult(input: {
    reservationId: string;
    settled: boolean;
  }): Promise<void>;
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
  paidAmountRaw?: string;
  /** Full price minus what was paid, when the World discount was honoured. */
  savedAmountRaw?: string;
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
  headers["idempotency-key"] = options.idempotencyKey ?? randomUUID();
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

function quoteWithinBudget(
  paymentRequired: PaymentRequired,
  maxPaymentRaw: string | undefined,
): boolean {
  if (maxPaymentRaw === undefined) return true;
  if (!/^\d+$/.test(maxPaymentRaw)) return false;
  const amounts = paymentRequired.accepts ?? [];
  return (
    amounts.length > 0 &&
    amounts.every(
      (requirement) =>
        /^\d+$/.test(requirement.amount) &&
        BigInt(requirement.amount) <= BigInt(maxPaymentRaw),
    )
  );
}

function paymentBudgetFailure<T>(): PaidFetchResult<T> {
  return {
    status: 403,
    ok: false,
    code: "X402_PAYMENT_BUDGET_EXCEEDED",
    message: "The quoted payment exceeds the remaining authorized budget.",
    retryable: false,
    paid: false,
    discounted: false,
  };
}

async function reservePayment(
  options: PaidFetchOptions,
  url: string,
  headers: Record<string, string>,
  phase: "discount" | "full",
  amountRaw: string | undefined,
) {
  if (!options.paymentLifecycle) return null;
  if (!amountRaw || !/^\d+$/.test(amountRaw)) {
    throw new Error("X402_PAYMENT_QUOTE_INVALID");
  }
  return options.paymentLifecycle.beforePayment({
    url,
    idempotencyKey: headers["idempotency-key"]!,
    phase,
    amountRaw,
  });
}

async function recordPaymentResult(
  options: PaidFetchOptions,
  reservation: { reservationId: string } | null,
  settled: boolean,
) {
  if (!reservation || !options.paymentLifecycle) return;
  await options.paymentLifecycle.paymentResult({
    reservationId: reservation.reservationId,
    settled,
  });
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
      if (!quoteWithinBudget(discountedQuote, options.maxPaymentRaw)) {
        return paymentBudgetFailure<T>();
      }
      let identityHeader: string | null = null;
      try {
        identityHeader =
          await agentkitClientFor(wallet).createHeader(extension);
      } catch {
        identityHeader = null;
      }
      if (identityHeader) {
        const reservation = await reservePayment(
          options,
          url,
          headers,
          "discount",
          discountedQuote.accepts?.[0]?.amount,
        );
        let payload;
        try {
          payload = await http.createPaymentPayload(discountedQuote);
        } catch {
          await recordPaymentResult(options, reservation, false);
          payload = null;
        }
        if (payload) {
          const discountedResponse = await fetch(url, {
            ...init,
            headers: {
              ...headers,
              [AGENTKIT]: identityHeader,
              ...http.encodePaymentSignatureHeader(payload),
            },
          });

          if (discountedResponse.status !== 402) {
            await recordPaymentResult(options, reservation, true);
            const paidAmountRaw = discountedQuote.accepts?.[0]?.amount;
            return toResult<T>(
              discountedResponse,
              true,
              true,
              paidAmountRaw,
              amountDifference(
                paymentRequired.accepts?.[0]?.amount,
                paidAmountRaw,
              ),
            );
          }
          await recordPaymentResult(options, reservation, false);
          const fullPriceChallenge = await fetch(url, init);
          if (fullPriceChallenge.status !== 402) {
            return toResult<T>(fullPriceChallenge, false, false);
          }
          paymentRequired = await readQuote(fullPriceChallenge);
        }
      }
    }
  }

  if (!quoteWithinBudget(paymentRequired, options.maxPaymentRaw)) {
    return paymentBudgetFailure<T>();
  }
  const reservation = await reservePayment(
    options,
    url,
    headers,
    "full",
    paymentRequired.accepts?.[0]?.amount,
  );
  let payload;
  try {
    payload = await http.createPaymentPayload(paymentRequired);
  } catch (error) {
    await recordPaymentResult(options, reservation, false);
    throw error;
  }
  const paidResponse = await fetch(url, {
    ...init,
    headers: { ...headers, ...http.encodePaymentSignatureHeader(payload) },
  });
  await recordPaymentResult(options, reservation, paidResponse.status !== 402);
  return toResult<T>(
    paidResponse,
    true,
    false,
    paymentRequired.accepts?.[0]?.amount,
  );
}

function amountDifference(
  fullRaw: string | undefined,
  paidRaw: string | undefined,
): string | undefined {
  if (
    !fullRaw ||
    !paidRaw ||
    !/^\d+$/.test(fullRaw) ||
    !/^\d+$/.test(paidRaw)
  ) {
    return undefined;
  }
  const saved = BigInt(fullRaw) - BigInt(paidRaw);
  return saved > 0n ? saved.toString() : undefined;
}

async function toResult<T>(
  response: Response,
  paid: boolean,
  discounted: boolean,
  paidAmountRaw?: string,
  savedAmountRaw?: string,
): Promise<PaidFetchResult<T>> {
  const amounts = {
    ...(paidAmountRaw ? { paidAmountRaw } : {}),
    ...(savedAmountRaw ? { savedAmountRaw } : {}),
  };
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
      ...amounts,
    };
  }
  return {
    status: response.status,
    ok: body.data.ok === true,
    code:
      body.data.code ??
      (paid && response.status === 402
        ? "X402_PAYMENT_VALIDATION_FAILED"
        : undefined),
    message:
      body.data.message ??
      (paid && response.status === 402
        ? "The x402 validator rejected the signed payment."
        : undefined),
    retryable:
      body.data.retryable === true ||
      (paid && response.status === 402 ? false : undefined),
    data: (body.data.data ?? undefined) as T | undefined,
    intent: body.data.intent ?? null,
    paid,
    discounted,
    ...amounts,
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
