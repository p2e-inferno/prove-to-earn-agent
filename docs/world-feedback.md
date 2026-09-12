# World AgentKit — Integration Notes & Feedback

World AgentKit provides the human-backed identity layer for the Prove to Earn Agent.

## Integration

The agent gateway integrates with AgentBook to register an agent and resolve the human associated with its wallet.

Relevant code:

- [`src/vendor/agent-world/registration.ts`](../src/vendor/agent-world/registration.ts) — nonce retrieval, registration proof submission, and human lookup
- [`src/vendor/agent-world/lifecycle.ts`](../src/vendor/agent-world/lifecycle.ts) — lifecycle-aware AgentBook RPC handling
- [`packages/agent-gateway/src/routes/agents/world.ts`](../packages/agent-gateway/src/routes/agents/world.ts) — gateway routes for registration, status, and resolution

The gateway uses `@worldcoin/agentkit` and `@worldcoin/agentkit-core`.

## Why we use it

The important question for P2E Inferno is not simply whether an agent controls a wallet, but whether that agent is operating on behalf of a human.

AgentBook gives us that additional identity signal and lets the gateway distinguish a human-backed agent from an arbitrary automated wallet.

## Developer feedback

The AgentBook model fits our use case well, especially the separation between the agent wallet and the human behind it.

The main improvement we would like is a clearer end-to-end integration guide covering the complete AgentBook flow in one place:

`nonce → signal/proof → registration → human lookup`

More explicit Sandbox examples and troubleshooting guidance for each stage would also make it easier to diagnose whether a failure is coming from the app configuration, proof flow, RPC state, or AgentBook registration itself.

## Testing scope

The World integration in this repository comes from the ETHOnline feature work and was carried into the public carve-out.

We did not re-run the full World ID Sandbox proof flow while preparing the public repository, so this document does not claim additional Sandbox coverage from the extraction process.