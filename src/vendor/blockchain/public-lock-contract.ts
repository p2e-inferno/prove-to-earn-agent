import { abi as publicContractAbi } from "./public-lock-abi";

/**
 * Vendored from `constants/index.ts` (PUBLIC_LOCK_CONTRACT only — the rest of
 * that barrel file, e.g. UNLOCK_FACTORY_ADDRESSES, is vendored separately).
 */
export const PUBLIC_LOCK_CONTRACT = {
  abi: publicContractAbi,
};
