# Reference material (not part of the supported build)

Everything under `reference/` is excluded from `tsconfig.json`'s `include`
and is **not** compiled, tested, or exercised by CI. It exists so a reviewer
can see the real host-side integration this gateway/runner was built
against, without this repo trying to reproduce the private
`p2einferno-app` monorepo it came from.

## `migrations/` — the real SQL

Migrations `260`–`273` from `p2einferno-app`, copied verbatim. These create
the actual Postgres schema and RPCs the gateway/runner call through
`src/adapters/datastore.ts` — `acquire_agent_run_execution`,
`renew_agent_run_lease`, `checkpoint_agent_run_execution`, the headless
authorization/effect-accounting tables and functions in `266`–`271`, and the
idempotency-index fixes in `272`/`273`. **This is the actual atomic
reservation / version-check / idempotency logic** the execution adapter
relies on — it is real SQL, not something reimplemented in this repo.

To run the supported build against a real database, apply these migrations
(in order) to a Postgres instance and point `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` at it. The integration tests that exercise this
path have not been run against a fresh database as part of this carve-out —
see the handoff report for exactly which tests are unrun vs. passing.

## `app-integration/*.ts.reference` — host-side wiring, not extracted

These four files show how the private platform wires the gateway/runner
into a live Next.js app. They are genuinely host-specific (Next.js route
conventions, Inngest job orchestration tied to the private DB, and a
membership/spend-accounting layer that reads other private tables) and were
judged not worth a forced extraction — a real host reimplements this shape
against their own app, not by importing these files.

- `mcp-route.ts.reference` — the Next.js route handler that mounts the
  gateway's MCP server (`packages/agent-gateway/src/mcp/server.ts`, which
  *is* part of the supported build) at `/api/mcp`, including auth, batch
  request rejection, and x402 enforcement for economic MCP tools. A host
  using a different framework needs an equivalent thin adapter; this file is
  the reference for what that adapter has to do.
- `inngest-agent-execution.ts.reference` — the Inngest function that
  actually invokes `packages/agent-runner` for an owner-invoked run: command
  polling, worker lifecycle, retry/backoff. The runner itself
  (`packages/agent-runner/src`) is fully in the supported build; this file
  is the job-queue glue around it.
- `effect-accounting.ts.reference` — transaction/payment reservation and
  reconciliation hooks that sit between the gateway's spend tracking
  (`packages/agent-runner/src/spend.ts`, supported) and the private
  platform's own ledger tables.
- `agent-chat-{commands,contextual-command,respond}.ts.reference` — the
  human-facing chat command loop above `src/vendor/agent-chat/store.ts`
  (which *is* vendored and supported).

None of these are imported by the supported build. Read them to understand
the integration; don't expect them to compile standalone.
