# prove-to-earn-agent

An autonomous, x402-paying agent gateway and runner: an agent gets granted
scoped, owner-invoked access to complete quests, pays per-call in USDC over
[x402](https://x402.org) for both its own economic actions and its reads
from [The Graph](https://thegraph.com), swaps on Uniswap v3 (Base) to fund
itself, and registers with World's AgentBook. Built for ETHOnline 2026.

This is a **public, standalone carve-out** of the agent subsystem from a
larger private platform (P2E Inferno). It is not that platform, and it does
not try to be — see "Carve-out boundary" below before assuming any given
file is either fully self-contained or fully reference-only.

## What's here

| Package | What it is |
|---|---|
| [`packages/agent-gateway`](packages/agent-gateway) | HTTP route handlers, x402 pricing/payment enforcement, MCP server, OAuth surface, headless authorization, World registration routes |
| [`packages/agent-runner`](packages/agent-runner) | The agent itself: planning, candidate generation, action selection/execution, Uniswap swap execution, spend tracking, execution recovery |
| [`packages/agent-contracts`](packages/agent-contracts) | Shared zod request/response schemas between gateway and runner |
| [`packages/dg-vendor-subgraph`](packages/dg-vendor-subgraph) | The Graph subgraph indexing DG Token Vendor activity on Base — what `agent-runner` pays x402 to query |
| [`src/vendor/`](src/vendor) | Generic infra vendored from the private platform as-is (Uniswap routing/fees, blockchain ABIs, logging, rate limiting, EAS config, World AgentBook client) |
| [`src/adapters/`](src/adapters) | Small interfaces standing in for private-platform services this repo does not include (quest engine, identity, membership, datastore) — see the table below |
| [`examples/minimal-usage`](examples/minimal-usage) | One script wiring a fixture adapter and driving a full quest run |
| [`reference/`](reference) | Real SQL migrations and host-integration code, **not part of the build** — see [`reference/README.md`](reference/README.md) |

## Install, build, test, run

```bash
npm install --legacy-peer-deps   # peer-dep conflict is pre-existing (next/react version pins), harmless here
npm run typecheck
npm test
npm run example
```

All three commands are verified as of this repo's scaffold commit: `npm run typecheck` is clean, `npm test` is 37/37 suites and 353/353 tests passing, and `npm run example` runs the full quest flow below end to end.

The example above needs **no environment variables** — it only exercises
the in-memory `QuestAdapter` fixture. To run against real infrastructure,
copy `.env.example` to `.env` and fill in what you need (Supabase/Postgres
with `reference/migrations/` applied, Privy, an RPC provider, etc.) — the
supported build resolves and typechecks without any of it; it just throws
clear "not configured" errors at the specific call sites that need real
credentials, rather than failing to build.

## Before the event / during the event / for this submission

- **Before ETHOnline 2026**: nothing here. This is a new feature.
- **During the event**: the entire agent gateway/runner/subgraph/contracts
  feature — commits
  [`89b43b1`](../../commit/89b43b1) through
  [`54129dd`](../../commit/54129dd) in this repo's history — real author,
  real dates, extracted verbatim (tree-filtered to the four packages above)
  from the private platform's `feat/agent-gateway-x402` branch.
- **Added for public extraction** (everything from the scaffold commit
  onward): `src/adapters/`, `src/vendor/`, root build config, this README,
  `reference/`, and the sponsor docs. See
  [`docs/dev-process/AI-USE.md`](docs/dev-process/AI-USE.md) for exactly
  what was AI-assisted in each phase.

## Carve-out boundary — what a host must supply

This is the part to actually read before assuming a route "just works."

| Concern | Status | Where |
|---|---|---|
| Uniswap swap routing, fees, Permit2 approvals | **Real, vendored exactly** | `src/vendor/uniswap/` |
| Agent planning/execution/recovery, spend tracking, x402 payment | **Real, in `packages/agent-runner`** | — |
| Execution lease acquisition/renewal/checkpointing (atomic, versioned) | **Real code — but needs a real Postgres with `reference/migrations/` applied** | `src/vendor/quests/agent-execution.ts` |
| Run reports, owner balance display, agent chat store | **Real code, same DB dependency** | `src/vendor/quests/`, `src/vendor/agent-chat/` |
| The Graph queries (Uniswap history + DG Vendor subgraph) | **Real code**; needs `GRAPH_*` env + a deployed subgraph (see below) | `packages/agent-runner/src/graph.ts` |
| EAS attestation config/schema resolution | **Real code**, simplified (static network fallback, env-only schema UIDs — see file header) | `src/adapters/attestation.ts` |
| World AgentBook registration | **Real code, vendored** | `src/vendor/agent-world/` |
| Quest catalogue / start / complete / claim reward | **Interface + in-memory fixture only** — the real engine (XDG economy, eligibility rules, abuse checks) is private platform logic, not extracted | `src/adapters/quests.ts` |
| Identity (Privy) wallet lookup | **Real**, against `@privy-io/server-auth` | `src/adapters/identity.ts` |
| Anti-wallet-lending check (`resolveSafeLinkedWalletCandidates`) | **Fixture only** (trusts every linked wallet) — the real check needs a private `wallet_link_map` table | `src/adapters/identity.ts` |
| Membership/lock ownership check | **Fixture only** (always true) — real check is an Unlock Protocol lock read, not extracted | `src/adapters/membership.ts` |
| MCP route mounting, Inngest job orchestration, effect-accounting | **Reference code only, not compiled/tested** | `reference/app-integration/` |

## The Graph — what's real vs. what's not

The runner's `fetchAgentHistory` (`packages/agent-runner/src/graph.ts`)
pays x402, per query, through The Graph's gateway for two subgraphs: a
public Uniswap v3 subgraph and `packages/dg-vendor-subgraph` (ours — indexes
`DGTokenVendor` purchase/sale/light-up/stage-upgrade events on Base). This
is real, working code, not a fixture — set `GRAPH_GATEWAY_URL`,
`GRAPH_VENDOR_SUBGRAPH_ID`, `GRAPH_UNISWAP_SUBGRAPH_ID` (and deploy
`dg-vendor-subgraph` yourself via `npm run deploy` in that package, or point
at an already-deployed instance) to exercise it live.

**Accurate scope of what that data does**: the runner uses this Graph
history as *reporting/narration context* — what the agent tells its owner
about the run — not as an input to action selection. Delegated-client runs
skip the fetch entirely. If your evaluation criteria require Graph data to
drive a decision rather than describe one, that is a gap in this
implementation, not something this README is papering over.

## Which examples/tests use fixtures

- `examples/minimal-usage/run.ts` uses the in-memory `QuestAdapter` fixture
  exclusively — no live services.
- Adapted unit tests under `packages/agent-gateway/src/**/*.test.ts` and
  `packages/agent-runner/src/**/*.test.ts` mock at the adapter boundary
  (`@adapters/*`, `@vendor/*`) the same way the originals mocked
  `@/lib/*` — see the handoff report in the PR/commit history for which
  suites were adapted vs. left as documented gaps.
- Nothing in the supported build talks to a real database, real Privy app,
  or real EAS contract in CI — those paths are typechecked but not
  exercised end-to-end. Real execution-lease/versioning behavior is
  real SQL in `reference/migrations/`, verified previously as an
  integration test in the private repo, **not re-run here** — see
  `reference/README.md`.

## Sponsor integrations

- **The Graph** — see above. Live query path:
  `packages/agent-runner/src/graph.ts`.
- **Uniswap v3** — see [`FEEDBACK.md`](FEEDBACK.md) for the code pointers
  and firsthand experience notes.
- **World AgentKit** — see [`docs/world-feedback.md`](docs/world-feedback.md).

## License

MIT — see [`LICENSE`](LICENSE).
