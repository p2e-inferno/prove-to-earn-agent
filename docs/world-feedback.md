# World AgentKit — integration notes and feedback

## What's actually integrated

- AgentBook registration (nonce fetch, signal construction, proof
  submission, human lookup):
  [`src/vendor/agent-world/registration.ts`](../src/vendor/agent-world/registration.ts)
  — `AGENTBOOK_APP_ID`, `AGENTBOOK_CONTRACT`,
  `submitAgentBookRegistration`, `lookupAgentBookHuman`.
- Lifecycle-versioned RPC wrapper used around AgentBook/agent-state calls:
  [`src/vendor/agent-world/lifecycle.ts`](../src/vendor/agent-world/lifecycle.ts).
- Gateway-side registration routes (world sign-up, status, resolution) built
  on the above: `packages/agent-gateway/src/routes/agents/world.ts`.
- `@worldcoin/agentkit` / `@worldcoin/agentkit-core` are declared
  dependencies of `packages/agent-gateway` and used from that route.

This is real, previously-shipped integration code (carried over from the
private platform's `feat/agent-gateway-x402` branch, commits `a3fd8438` /
`1d66b37b`), not written fresh for this submission.

## What this document is *not*

This carve-out session (the AI-assisted extraction work done in the ~24
hours before submission) did **not** perform live World ID Sandbox App
testing, developer-portal navigation, or proof-flow verification as part of
building this public repo — that firsthand testing happened, if at all,
during the original feature's development on the private branch, and
belongs to you (the developer) to document from memory/notes rather than
have this session invent it.

**Action needed from you before submission**: fill in the sections below
from your actual experience building against World AgentKit. Do not let
this file ship with placeholder claims — an unfilled section here is more
honest than a fabricated one.

### AgentKit documentation and integration
_(your notes)_

### Developer Portal — navigation, search, discovery, debugging
_(your notes)_

### Sandbox App — states, proof flows, test users, errors, edge cases actually exercised
_(your notes — if you did not run Sandbox App testing for this feature, say so explicitly here rather than leaving it blank)_

### What was confusing, missing, broken, or hard to test
_(your notes)_
