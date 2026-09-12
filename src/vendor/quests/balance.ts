import { createAgentAdminClient } from "@adapters/datastore";
import { getLogger } from "@vendor/logger";
import {
  ok,
  fail,
  type QuestPrincipal,
  type ServiceResult,
} from "@vendor/quests/principal";

const log = getLogger("quests:daily:services:balance");

/**
 * Owner xDG balance. The unit is xDG — the in-app earned balance — not the
 * on-chain DG token, which only exists after a pull-out.
 */
export async function getOwnerBalance(
  principal: QuestPrincipal,
): Promise<ServiceResult> {
  const supabase = createAgentAdminClient();

  const { data: profile, error } = await supabase
    .from("user_profiles")
    .select("id,experience_points")
    .eq("privy_user_id", principal.userId)
    .maybeSingle();

  if (error) {
    log.error("Failed to fetch owner balance", {
      userId: principal.userId,
      error,
    });
    return fail(500, "BALANCE_FETCH_FAILED", "Failed to fetch balance");
  }
  if (!profile) {
    return fail(404, "PROFILE_NOT_FOUND", "User profile not found");
  }

  const { data: buckets, error: bucketsError } = await supabase
    .from("user_xdg_bucket_balances")
    .select("bucket,balance")
    .eq("user_profile_id", profile.id);

  // The headline balance still stands without the per-bucket split, so this
  // reports an empty breakdown rather than failing the whole read.
  if (bucketsError) {
    log.warn("Failed to fetch owner bucket balances", {
      userId: principal.userId,
      error: bucketsError,
    });
  }

  return ok({
    xdgBalance: profile.experience_points || 0,
    buckets: (buckets || []).map((b) => ({
      bucket: b.bucket,
      balance: b.balance,
    })),
    rewardWallet: principal.rewardWallet,
  });
}
