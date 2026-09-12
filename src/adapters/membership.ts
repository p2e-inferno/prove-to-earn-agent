/**
 * Membership adapter — "does this wallet hold an active membership".
 *
 * The private implementation (`lib/chat/server/respond-membership.ts`)
 * checks Unlock Protocol lock ownership on-chain via
 * `checkUserKeyOwnership` (`lib/services/user-key-service.ts`), which is not
 * part of this carve-out. A real host can implement this by reading
 * `PublicLock.getHasValidKey(wallet)` against their membership lock address,
 * using the vendored ABI/client in `src/vendor/blockchain/` and
 * `src/vendor/blockchain/public-lock-contract.ts`.
 */
export type MembershipCheck = (wallet: string) => Promise<boolean>;

/** Fixture default: everyone is treated as an active member. */
const fixtureHasActiveMembership: MembershipCheck = async () => true;

let activeCheck: MembershipCheck = fixtureHasActiveMembership;

export function configureMembershipCheck(check: MembershipCheck): void {
  activeCheck = check;
}

export const hasActiveChatMembership: MembershipCheck = (wallet) =>
  activeCheck(wallet);
