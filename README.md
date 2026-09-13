# Prove to Earn Agent

**Autonomous quest execution for P2E Inferno.**

Prove to Earn (P2E Inferno) is a platform where users complete onchain actions, prove what they did, earn rewards, and progress through Daily Quests.

For ETHOnline 2026, we built an agent layer on top of that system.

A human can authorize an agent with a scoped, revocable permission. From there, the agent can interact with the quest gateway, pay for services through x402, query live blockchain data through The Graph, execute supported Uniswap v3 actions from its own wallet on Base, submit the resulting transaction for verification, and complete supported quest flows on the owner's behalf.

World AgentKit and AgentBook provide the human-backed identity layer for the agent.

This repository is the public carve-out of that new agent subsystem. The full P2E Inferno application and quest economy remain private.

## Continuity Track

P2E Inferno existed before ETHOnline. The agent system did not.

### Before ETHOnline

The existing product already included:

- the Daily Quest engine and eligibility rules
- transaction verification
- the xDG reward economy
- Uniswap v3 routing, quoting, Permit2 approvals, and the P2E fee path
- EAS task attestations
- Unlock Protocol memberships and completion keys
- user identity, wallet linking, and abuse controls

Users completed these flows manually.

### Built during ETHOnline

The ETHOnline work adds autonomous execution:

- agent registration and owner authorization
- scoped and revocable agent permissions
- agent wallet authentication and sessions
- x402-paid agent APIs
- the autonomous agent runner
- agent planning, execution recovery, and spend tracking
- Uniswap execution from the agent wallet
- The Graph query integration
- the DG Token Vendor subgraph
- World AgentKit / AgentBook integration
- shared gateway/runner contracts and schemas
- MCP and headless agent interfaces

The feature work in the extracted history spans commits `89b43b1` through `54129dd`.

Additional commits prepare the subsystem for this public repository: adapters for private host services, vendored dependencies from the existing product, build configuration, examples, documentation, and sponsor feedback files.

## How it works

The human remains the owner of the P2E account. The agent is an authorized actor with its own wallet.

1. The owner authorizes an agent and defines its scope.
2. The agent authenticates using its wallet.
3. The agent discovers available quest work through the gateway.
4. The runner queries live Uniswap and DG Token Vendor history through The Graph and gives that onchain history to the planner as context for the run.
5. For a supported Uniswap task, the agent prepares the required Permit2 approvals and executes the existing P2E Inferno swap path through Uniswap's Universal Router.
6. The resulting transaction hash is submitted back to P2E Inferno.
7. The existing quest logic verifies that the transaction satisfies the task requirements.
8. The agent claims the task reward and completes the supported quest flow.
9. Where a completion key is issued, it belongs to the human owner rather than the agent.

The result is the same Prove to Earn system, with an autonomous actor capable of carrying out supported work on a user's behalf.

## Architecture

```mermaid
flowchart LR
    Owner[Human Owner]
    Agent[Agent Runner]
    Gateway[Agent Gateway]
    Graph[The Graph]
    World[World AgentKit / AgentBook]
    Uni[Uniswap v3 / Universal Router]
    P2E[P2E Inferno Quest Engine]
    EAS[EAS]
    Unlock[Unlock Protocol]

    Owner -->|authorizes| Gateway
    Agent -->|wallet auth + x402| Gateway
    Gateway -->|agent identity| World

    Agent -->|live onchain history| Graph
    Agent -->|execute swap| Uni
    Agent -->|submit tx / claim / complete| Gateway

    Gateway --> P2E
    P2E -->|task attestations| EAS
    P2E -->|completion keys| Unlock


    | Path                                                         | Purpose                                                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/agent-gateway`](packages/agent-gateway)           | Agent-facing HTTP routes, authentication, x402 pricing/payment enforcement, MCP surface, OAuth/headless authorization, and World registration                 |
| [`packages/agent-runner`](packages/agent-runner)             | Agent planning, action selection, execution, recovery, Uniswap actions, Graph queries, and spend tracking                                                     |
| [`packages/agent-contracts`](packages/agent-contracts)       | Shared Zod request/response schemas used by the gateway and runner                                                                                            |
| [`packages/dg-vendor-subgraph`](packages/dg-vendor-subgraph) | Subgraph indexing DG Token Vendor activity on Base                                                                                                            |
| [`src/vendor`](src/vendor)                                   | Existing infrastructure brought across from P2E Inferno, including Uniswap, blockchain ABIs, EAS configuration, rate limiting, logging, and World integration |
| [`src/adapters`](src/adapters)                               | Interfaces between the public agent subsystem and services that remain inside the private P2E Inferno application                                             |
| [`examples/minimal-usage`](examples/minimal-usage)           | Small runnable example using the in-memory quest adapter                                                                                                      |
| [`reference`](reference)                                     | Database migrations and host-integration examples provided for reference but not compiled as part of the standalone build                                     |

## Quick start
npm install --legacy-peer-deps
npm run typecheck
npm test
npm run example

The minimal example does not require environment variables. It uses the in-memory `QuestAdapter` so the agent flow can be inspected without access to the private P2E Inferno backend.

At the time of this public extraction:

- `npm run typecheck` passes 
- `npm test` passes 38/38 suites and 364/364 tests
- `npm run example` completes the fixture-backed quest flow end to end

For live infrastructure, copy `.env.example` to `.env` and configure the services you want to exercise.

## Public repo boundary

This repository contains the agent subsystem built for ETHOnline and enough infrastructure to build, test, and understand it without publishing the full P2E Inferno application.

Some integrations are included directly, while private product services are represented through adapters.

### Included implementations

The following code is included in the supported build:

- agent gateway and authentication
- x402 payment flow
- agent runner, planning, recovery, and spend tracking
- Uniswap routing and Permit2 support
- The Graph query client
- DG Token Vendor subgraph
- World AgentBook integration
- Privy identity lookup
- EAS network/schema configuration
- execution lease and run-report infrastructure

Some database-backed functionality requires the migrations under `reference/migrations/` and a configured Postgres/Supabase instance.

### Host-provided services

The following belong to the private P2E Inferno application and are represented by adapters in this repository:

**Quest engine**

`src/adapters/quests.ts`

The public example uses an in-memory implementation. The production version contains the Daily Quest economy, eligibility rules, reward logic, transaction verification, and abuse controls.

**Safe wallet resolution**

`src/adapters/identity.ts`

The production system includes additional wallet-linking checks that prevent one wallet from being lent across multiple P2E accounts. The standalone fixture accepts the linked wallets supplied to it.

**Membership checks**

`src/adapters/membership.ts`

The production implementation checks Unlock Protocol lock ownership. The standalone adapter uses a fixture.

### Reference-only integration code

Some host-level integration is included under [`reference`](reference) for reviewers who want to see how the subsystem connects to P2E Inferno.

This includes database migrations, application wiring, orchestration, and other integration code that is not part of the standalone build.

See [`reference/README.md`](reference/README.md) for details.

## The Graph

The Graph is the agent's live onchain memory layer.

Before planning a supported quest run, the runner queries live blockchain history for the agent wallet from:

* the Uniswap v3 subgraph, for recent swap activity
* the P2E Inferno DG Token Vendor subgraph, for purchases, sales, Light Ups, stage progression, and account totals

These queries are made through The Graph's x402 gateway, so the agent can autonomously pay for the blockchain data it consumes.

The returned history is normalized into structured context, including recent activity and subgraph indexing state, and passed into the agent planner alongside the current quest tasks. The planner can reason over that history while choosing and sequencing safe candidate actions. Graph data does not override quest requirements or safety checks; execution remains bounded by the candidates and constraints produced by the runner.

The same Graph-grounded history is also carried into the run report so the agent can explain the current run in the context of what the wallet has already done onchain.

The live query path is implemented in:

[`packages/agent-runner/src/graph.ts`](packages/agent-runner/src/graph.ts)

The planner consumes that context in:

[`packages/agent-runner/src/planner.ts`](packages/agent-runner/src/planner.ts)

The custom DG Token Vendor subgraph is included in:

[`packages/dg-vendor-subgraph`](packages/dg-vendor-subgraph)

To exercise the live Graph path, configure:

```text
GRAPH_GATEWAY_URL
GRAPH_VENDOR_SUBGRAPH_ID
GRAPH_UNISWAP_SUBGRAPH_ID
```
