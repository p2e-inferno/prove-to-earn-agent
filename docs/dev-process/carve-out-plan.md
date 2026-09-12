# Carve out the Agent Gateway into `p2e-inferno/prove-to-earn-agent`

## Context

The hackathon requires a public, open-source, independently buildable repo. The
candidate feature — the Agent Gateway (`packages/agent-gateway`) and Agent
Runner (`packages/agent-runner`) implementing the x402-paid, owner-invoked
quest agent — lives inside the private `p2einferno-app` monorepo, on
`feat/agent-gateway-x402`.

Investigation found two things that rule out a simple `git filter-repo` copy:

1. **Not standalone.** The two packages make ~41 distinct imports into the
   private app's `lib/` and `constants/` — some are generic infra (logger,
   rate limiter, Uniswap routing math, blockchain ABI constants), but several
   are real product/business logic owned by P2E Inferno (the daily-quest
   completion services, the Supabase-backed agent schema client, chat/store
   persistence). Publishing those verbatim would leak proprietary platform
   logic, not just carve out a feature.
2. **Only 3 real commits.** The branch diverged from `main` in August and
   carries 26 commits total, but only `960ebb0f`, `a3fd8438`, and `1d66b37b`
   touch these two packages. Those are the only commits worth reusing with
   real authorship/dates; everything else on the branch is unrelated app work
   and must not be dragged in. There's also uncommitted WIP on top of
   `1d66b37b` — per your call, that stays out of this carve-out and can be
   added as a fresh commit later once it's ready.

Decision (confirmed with you): build a **scoped adapter layer**. The new repo
contains only the gateway + runner. Genuinely generic/leaf modules are vendored
in as-is. Business-logic touchpoints are replaced with small local interfaces
plus a reference/mock implementation the new repo owns — so it builds, runs,
and is demoable without the private monorepo, and without shipping P2E
Inferno's proprietary quest/data logic.

## Target repo layout

```
prove-to-earn-agent/
├── packages/
│   ├── agent-gateway/         # unchanged internal structure, imports rewired
│   └── agent-runner/
├── src/adapters/               # NEW — interfaces + reference implementations
│   ├── identity/                (Privy-backed, real SDK, generic)
│   ├── quests/                  (in-memory reference QuestAdapter)
│   ├── execution/                (in-memory ExecutionAdapter + reports)
│   ├── chat/                    (in-memory ChatAdapter)
│   ├── attestation/              (real EAS SDK, env-configurable schema/network)
│   └── datastore/                (in-memory/SQLite AgentDatastore)
├── .github/workflows/ci.yml
├── README.md
├── LICENSE                      (MIT)
├── .env.example
├── package.json / tsconfig.json (root workspace)
```

## Classification of the ~41 cross-package imports

**A — vendor as-is (generic infra, no proprietary logic).** Copied into the
repo under each package's own `lib/` (or a shared `src/vendor/` if duplicated
by both packages):
`lib/utils/logger.ts`, `lib/utils/rate-limiter.ts`,
`lib/utils/agent-rate-limiter.ts`, `lib/quests/principal.ts` (pure
`QuestPrincipal`/`ok`/`fail` envelope), `lib/attestation/api/types.ts` (pure
interfaces), `lib/uniswap/*` (route, constants, types, permit2, abi,
encode-swap — DEX routing math, not P2E business logic), `lib/blockchain/shared/*`
(ABI definitions, vendor ABI, attribution), `lib/blockchain/config*`,
`lib/vendor/math.ts`, `lib/wallet/tokenAddresses.ts`, `lib/graph/queries.ts`,
`lib/ai/client.ts` + `types.ts`, `lib/upstash/redis.ts`,
`constants/unlock_factory_addresses.ts`, `lib/inngest/client.ts` (trivial
Inngest instantiation — Inngest itself is a normal third-party dependency, not
proprietary).

**B — replace with an adapter interface + reference implementation:**
- `lib/quests/daily-quests/services/{read,start,complete-quest,complete-task,
  claim-task-reward,balance}.ts` → `QuestAdapter` interface. Reference impl:
  small in-memory quest catalog/run store, enough to demo start→complete→claim.
- `lib/quests/daily-quests/services/agent-execution.ts` + `reports.ts` →
  `ExecutionAdapter` interface (mutate/list/resolve executions, record/list
  run reports). In-memory reference impl.
- `lib/agent-chat/server/{executable-quests,store}.ts` → folded into
  `QuestAdapter`/`ChatAdapter`.
- `lib/supabase/agent-schema.ts`, `lib/supabase/server.ts` → `AgentDatastore`
  interface (the one thing `createAgentAdminClient()` callers actually need:
  CRUD on agent registration/wallet/lifecycle rows). Reference impl: in-memory
  store; README documents the shape a real Postgres-backed implementation
  would need.
- `lib/auth/privy.ts`, `lib/auth/filter-mapped-linked-wallet.ts` →
  `IdentityAdapter` interface (`resolveOwner`, `resolveLinkedWallets`,
  `resolveSafeCandidates`). Reference impl keeps real `@privy-io/server-auth`
  (Privy is third-party, not proprietary) but drops the P2E-specific
  wallet-link-map table logic behind the interface, documented as a stub.
- `lib/attestation/core/config.ts`, `core/network-config.ts`,
  `lib/attestation/schemas.ts` → `AttestationAdapter`. Reference impl keeps
  the real EAS SDK (public infra) but makes schema UIDs and network config
  env-driven instead of hardcoding P2E's deployed `P2E_SCHEMA_UIDS`.
- `lib/agent-world/{registration,lifecycle}.ts` → vendor mostly as-is (calls
  World's public AgentBook contract; app ID/contract address are already
  public), but pull the hardcoded IDs into `.env.example` for clarity.

Every touchpoint in the gateway/runner source (`@/lib/...` imports) gets
rewritten to import from `src/adapters/*` or the local vendored path instead.

## Mechanics — how this actually runs (local-first, push-last)

1. Clone the **new** empty repo locally as its own working directory:
   `git clone git@github.com:p2e-inferno/prove-to-earn-agent.git` (sibling
   directory, not nested in `p2einferno-app`). All commits for the new repo
   happen in this clone.
2. Make a **disposable, local-only clone of `p2einferno-app`** (in scratch
   space) to run `git filter-repo` in. `filter-repo` rewrites history
   destructively, so it only ever runs there — the real working copy and
   `feat/agent-gateway-x402` are never touched.
3. In that throwaway clone: `git filter-repo --path packages/agent-gateway
   --path packages/agent-runner` restricted to the 3 commits that touch those
   paths (`960ebb0f`, `a3fd8438`, `1d66b37b`), preserving real author/dates.
4. Graft that filtered history into the `prove-to-earn-agent` clone: add the
   throwaway clone as a temporary local git remote, fetch, then
   `merge --allow-unrelated-histories` (trivial — target repo is empty). This
   becomes the base of the new repo's history. Remove the throwaway clone
   afterward.
5. All subsequent work (scaffold, adapters, vendoring, rewiring, tests, CI)
   happens as normal file edits + commits directly inside the
   `prove-to-earn-agent` clone — built and run there like any other repo.
6. **Verify locally before every push**: `npm install`, `npm run build`,
   `npm test` inside the `prove-to-earn-agent` clone only (no path back into
   `p2einferno-app`), confirming it's genuinely standalone.
7. **Push in stages, not once at the end** — `git push origin main` at each
   checkpoint below, only after that checkpoint's local verification passes.

## Commit sequence (kept as separate, individually-buildable commits so the
push history is incremental, not a single dump)

1. History extraction + graft (mechanics above) — first push checkpoint.
2. `chore: scaffold repo` — root `package.json`/`tsconfig.json`, `.gitignore`,
   `LICENSE` (MIT), `README.md` (what this is, architecture diagram, "adapted
   from a private platform" note), `.env.example` (adapter-only vars, no real
   secrets/addresses beyond already-public contract addresses).
3. `refactor(adapters): introduce platform adapter interfaces` — the
   interface/type definitions only, no implementations yet.
4. `chore: vendor shared infra` — copy in the Category-A leaf modules.
5. `feat(adapters): add reference adapter implementations` — in-memory
   quest/execution/chat/datastore adapters, Privy-backed identity adapter,
   EAS-backed attestation adapter.
6. `refactor(gateway,runner): decouple from private monorepo imports` — rewire
   every `@/lib/...` import in `packages/agent-gateway/src` and
   `packages/agent-runner/src` to the new local paths.
7. `test: update suites for adapter-based interfaces` — fix/port the existing
   `*.test.ts` files (there are many) to the new interfaces; mock the
   adapters instead of the old app modules.
8. `chore(ci): add build/typecheck/test GitHub Actions workflow`.

Each commit gets pushed as its own step (a few `git push` checkpoints across
the sequence, not one push at the end) so the repo's visible history shows
real incremental progress.

## Secrets / IP scrub checklist (before every push)

- No `.env`, private keys, or real API keys (checked — none tracked, only
  `AGENT_PRIVATE_KEY = "0x01"` test fixtures, which are fine).
- No P2E-specific deployed schema UIDs, admin wallet addresses, or internal
  hostnames — replace with env placeholders.
- Confirm `.gitignore` excludes `node_modules`, `.env*`, build output before
  the first commit (currently `packages/*/node_modules` are untracked in the
  source repo — verify same here).
- Final `git log -p` skim over the new repo's commits before the last push.

## Verification

- `npm install && npm run build` and `npm run typecheck` in the new repo,
  from a clean clone, with no access to the private monorepo.
- `npm test` for both packages against the reference adapters.
- Manual smoke: run the reference in-memory quest adapter through a
  start→complete→claim cycle via the gateway's routes to confirm the demo
  path works end-to-end without Supabase/Privy/EAS credentials (identity/
  attestation adapters should have a "dev mode" that doesn't require real
  Privy/EAS env vars, so it runs out of the box).

## Sequencing note

Given the size (real refactor across ~40+ import sites plus new adapter code),
this session will execute Phase 1 (steps 1–2: real history extraction +
scaffold, pushed to the empty `prove-to-earn-agent` repo) first as the
concrete, reviewable starting point, then continue through steps 3–8 as
subsequent commits/pushes in this same session, checking in with you if the
adapter design for any specific touchpoint (especially the datastore and
identity adapters) needs a judgment call I shouldn't make alone.
