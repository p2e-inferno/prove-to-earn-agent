# Uniswap Foundation hackathon feedback

Written from actually shipping an autonomous agent that swaps on Uniswap v3
(Base) to fund its own quest completions and pull-outs. v3 was sufficient for
this use case — no v4 migration was needed or attempted.

## What we built against

- Pool/route resolution and fee configuration:
  [`src/vendor/uniswap/constants.ts`](src/vendor/uniswap/constants.ts) —
  `UNISWAP_ADDRESSES`, `ROUTE_CONFIG`, `FEE_CONFIG`, `resolvePoolTokens`.
- Swap quoting and route selection:
  [`src/vendor/uniswap/route.ts:17`](src/vendor/uniswap/route.ts#L17)
  (`resolveSwapRoute`) and
  [`route.ts:70`](src/vendor/uniswap/route.ts#L70) (`quoteSwapRoute`).
- Universal Router calldata encoding with our fee cut applied manually (not
  via a hosted fee-on-transfer hook):
  [`src/vendor/uniswap/encode-swap.ts:55`](src/vendor/uniswap/encode-swap.ts#L55)
  (`encodeSwapWithFeeManual`).
- Permit2 approval flow (approve once, then sign, no per-swap `approve` tx):
  [`src/vendor/uniswap/permit2.ts`](src/vendor/uniswap/permit2.ts) —
  `checkErc20ApprovalForPermit2`, `checkPermit2Allowance`,
  `approveTokenForPermit2`, `approveUniversalRouterViaPermit2`.
- The agent-side call site, including approval-then-swap sequencing and
  post-swap balance re-reads:
  [`packages/agent-runner/src/uniswap-action.ts`](packages/agent-runner/src/uniswap-action.ts),
  [`packages/agent-runner/src/approvals.ts`](packages/agent-runner/src/approvals.ts).

## Firsthand feedback

- **Permit2 + Universal Router is the right shape for an autonomous agent**:
  one approval covers many swaps, and the agent never has to hold a
  standing `approve` for the swap contract itself — it signs a
  time-boxed Permit2 permit per swap instead. This mattered more than we
  expected once the agent was running unattended: an unbounded token
  approval sitting on an agent-controlled wallet is a real risk we didn't
  want to carry.
- **Manual fee application via `encodeSwapWithFeeManual`** (splitting the fee
  out of the swap amount ourselves before encoding the Universal Router
  command, rather than routing through a fee-on-transfer token or a hosted
  fee mechanism) gave us exact control over what the agent pays vs. what the
  protocol/product takes — worth documenting as a first-class pattern
  alongside the permit-based approval flow, since it's the piece most
  guides skip.
- **Gap in our own testing, not Uniswap's tooling**: we did not run the swap
  path against a forked-mainnet integration test as part of this carve-out
  (see the handoff report) — this feedback reflects live devnet/testnet
  usage during development, not a from-scratch verification for this
  submission. Flagging that gap here rather than claiming coverage we don't
  have.
- No v4 features were evaluated; this was a deliberate scope decision to
  keep the fee-path behavior we'd already shipped stable rather than
  re-verify it under a new hook model during a time-boxed hackathon.

---

**Outstanding action (tracked separately, not done by this session):**
submit this feedback at
https://developers.uniswap.org/hackathon-feedback with a link to this file
at its commit-pinned URL once the extraction commits are finalized.
