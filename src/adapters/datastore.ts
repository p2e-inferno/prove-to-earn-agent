/**
 * Datastore adapter.
 *
 * The private platform's agent code (`db/agents.ts`, `headless-authorization.ts`,
 * the vendored execution/report/chat/balance modules under `src/vendor/quests`
 * and `src/vendor/agent-chat`) is written directly against a typed Supabase
 * client and a set of Postgres RPCs — `acquire_agent_run_execution`,
 * `renew_agent_run_lease`, `checkpoint_agent_run_execution`, and the headless
 * authorization/effect-accounting functions in
 * `reference/migrations/271_enforce_live_headless_effect_authority.sql` (and
 * its follow-ups, 272/273). Those RPCs *are* the atomic-reservation,
 * version-check and idempotency guarantees this system depends on — they are
 * real SQL, not something this repo reimplements in memory.
 *
 * So the supported integration boundary here is: point these factories at a
 * real Postgres/Supabase instance that has the migrations in
 * `reference/migrations/` applied. There is no in-memory fixture for this
 * adapter — an in-memory mock cannot honestly claim to provide the
 * concurrency/idempotency guarantees the SQL provides, and claiming otherwise
 * would be worse than admitting the gap. Tests that need real semantics
 * (`packages/agent-gateway/src/db/agents.capability.test.ts`, the execution
 * lease tests in `packages/agent-runner`) are integration tests against a
 * real database; see `reference/README.md` for prerequisites.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedAdminClient: SupabaseClient | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. This adapter requires a real Postgres/Supabase ` +
        "instance with the migrations in reference/migrations/ applied — " +
        "see reference/README.md.",
    );
  }
  return value;
}

/**
 * A single service-role Supabase client, shared by every datastore-backed
 * adapter in this repo. Mirrors the private platform's
 * `createAdminClient()` / `createAgentAdminClient()` /
 * `createHeadlessAgentAdminClient()` split, which exists there only to widen
 * a few RPC argument types for nullability — that distinction is not load
 * bearing here, so all three collapse to one factory.
 */
export function createAgentAdminClient(): SupabaseClient {
  if (cachedAdminClient) return cachedAdminClient;
  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  cachedAdminClient = createClient(url, key, {
    auth: { persistSession: false },
  });
  return cachedAdminClient;
}

export const createHeadlessAgentAdminClient = createAgentAdminClient;
export const createAdminClient = createAgentAdminClient;

/** Test-only escape hatch: point the shared client at a fresh instance. */
export function __resetAgentAdminClientForTests(client: SupabaseClient | null = null) {
  cachedAdminClient = client;
}
