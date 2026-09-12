/**
 * ERC-8021 transaction attribution (Base Builder Codes).
 *
 * A suffix appended to calldata that contracts ignore, letting Base attribute
 * volume to this app. Encoded with viem primitives rather than `ox/erc8021`:
 * the dependency tree already carries four copies of `ox`, and this emits a
 * single frozen schema-0 constant.
 */

import { stringToHex, size, concat, numberToHex, type Hex } from "viem";
import { getLogger } from "@vendor/logger";

const log = getLogger("blockchain:attribution");

const ERC8021_MARKER = "0x80218021802180218021802180218021";
const SCHEMA_0 = "0x00";

/** Mirrors the code registry's own rule; a code it would reject earns no attribution. */
export const BUILDER_CODE_PATTERN = /^[a-z0-9_]{1,32}$/;

/** Base mainnet and Base Sepolia both accrue Builder Code attribution. */
export const ATTRIBUTED_CHAIN_IDS = new Set([8453, 84532]);

/**
 * Schema 0, parsed backwards from the end of calldata:
 * codes ∥ codesLength (1 byte) ∥ schemaId (1 byte) ∥ marker (16 bytes).
 */
export function toDataSuffix(code: string): Hex | undefined {
  if (!BUILDER_CODE_PATTERN.test(code)) return undefined;
  const codesHex = stringToHex(code);
  return concat([
    codesHex,
    numberToHex(size(codesHex), { size: 1 }),
    SCHEMA_0,
    ERC8021_MARKER,
  ]);
}

let warnedInvalidCode = false;

/**
 * The suffix to configure on a wallet client, or `undefined` to leave
 * transactions unattributed. Never throws: attribution must not block a write.
 */
export function getDataSuffix(chainId: number | undefined): Hex | undefined {
  if (!chainId || !ATTRIBUTED_CHAIN_IDS.has(chainId)) return undefined;

  const code = process.env.NEXT_PUBLIC_BUILDER_CODE?.trim();
  if (!code) return undefined;

  const suffix = toDataSuffix(code);
  if (!suffix && !warnedInvalidCode) {
    warnedInvalidCode = true;
    log.warn(
      "NEXT_PUBLIC_BUILDER_CODE is not a valid Builder Code; attribution disabled",
    );
  }
  return suffix;
}

/**
 * Reads the suffix back off a configured client for paths that assemble
 * calldata themselves instead of going through viem's sending actions.
 */
export function resolveClientDataSuffix(client: {
  dataSuffix?: Hex | { value: Hex; required?: boolean | undefined } | undefined;
}): Hex | undefined {
  const configured = client.dataSuffix;
  if (!configured) return undefined;
  return typeof configured === "string" ? configured : configured.value;
}
