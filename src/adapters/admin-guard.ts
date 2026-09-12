/**
 * Stand-in for the private platform's admin-session guard
 * (`lib/auth/route-handlers/admin-guard.ts`), which protects
 * `/api/admin/*` in the host app. Nothing in the supported gateway routes
 * in this repo uses `{ guard: "admin-session" }` — this exists only so
 * `route-factory.ts`'s dynamic `import(...)` for that path resolves and
 * typechecks. A host that wires this route-factory option up for real
 * platform-admin routes must supply a real implementation.
 */
import type { NextRequest, NextResponse } from "next/server";

export async function ensureAdminOrRespond(
  _req: NextRequest,
): Promise<NextResponse | null> {
  throw new Error(
    "admin-session guard is not implemented in this carve-out — see src/adapters/admin-guard.ts",
  );
}
