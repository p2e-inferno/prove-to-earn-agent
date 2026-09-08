export const MAX_AGENT_BODY_BYTES = 64 * 1024;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TX_HASH_PATTERN = /^0x[0-9a-f]{64}$/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isTransactionHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && TX_HASH_PATTERN.test(value);
}

export function isValidIdempotencyKey(value: string | null): value is string {
  return Boolean(
    value &&
    value.length <= MAX_IDEMPOTENCY_KEY_LENGTH &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value),
  );
}
