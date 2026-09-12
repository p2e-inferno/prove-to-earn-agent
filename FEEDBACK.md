# Uniswap Integration & Feedback

P2E Inferno already used Uniswap v3 on Base for user-driven quest actions before ETHOnline 2026.

For the Continuity track, we extended that integration so an autonomous agent can execute the same verified swap path from its own wallet while preserving the routing, fee collection, and transaction-verification rules already used by the live product.

We deliberately stayed on Uniswap v3 for this build. Migrating to v4 was not necessary for the feature we were shipping, and preserving a production-tested swap path was more valuable than introducing a protocol migration during the hackathon.

## What existed before ETHOnline

The existing P2E Inferno integration already handled:

- pool and route configuration
- swap quoting
- Universal Router calldata encoding
- the P2E Inferno fee path
- Permit2 approvals

Relevant code:

- [`src/vendor/uniswap/constants.ts`](src/vendor/uniswap/constants.ts)  
  Pool, route, and fee configuration.

- [`src/vendor/uniswap/route.ts`](src/vendor/uniswap/route.ts)  
  `resolveSwapRoute` and `quoteSwapRoute`.

- [`src/vendor/uniswap/encode-swap.ts`](src/vendor/uniswap/encode-swap.ts)  
  `encodeSwapWithFeeManual`, which builds the Universal Router call while preserving the P2E Inferno fee path.

- [`src/vendor/uniswap/permit2.ts`](src/vendor/uniswap/permit2.ts)  
  ERC-20 and Permit2 approval handling.

## What we added during ETHOnline

The new work is the autonomous execution layer.

The agent runner can prepare the required approvals, execute the existing P2E Inferno Uniswap route from its own EOA wallet, and return the resulting transaction hash to the Daily Quest system for verification.

Relevant code:

- [`packages/agent-runner/src/uniswap-action.ts`](packages/agent-runner/src/uniswap-action.ts)  
  Agent-side swap execution using the existing P2E Inferno encoder.

- [`packages/agent-runner/src/approvals.ts`](packages/agent-runner/src/approvals.ts)  
  Approval and Permit2 preparation before execution.

The important design constraint was that the agent could not simply use any available swap route. P2E Inferno verifies the submitted transaction against the expected sender, Universal Router, token pair, and route. Using the same execution path as the existing product means agent activity remains compatible with those checks and continues through the same fee path.

## Feedback from building with Uniswap

### Permit2 fits autonomous wallets well

Permit2 was particularly useful for an unattended agent.

The wallet can establish the required ERC-20 approval for Permit2 and then use scoped Permit2 authorization for subsequent swaps instead of repeatedly sending token approval transactions.

For an agent-controlled wallet, reducing unnecessary standing approvals is a meaningful operational and security improvement.

### Universal Router gave us a predictable execution target

Our quest verification logic needs to know what the agent actually executed.

Using Universal Router gave us a consistent transaction destination and calldata structure that we could verify after execution. That matters more in an autonomous flow than it does in a normal UI, because the system has to determine programmatically whether the agent completed the requested action correctly.

### Fee-aware swap examples would be useful

P2E Inferno takes its application fee as part of the swap flow. We currently calculate the fee portion ourselves and encode the remaining swap through Universal Router.

Most examples naturally focus on getting a swap executed. More documentation around application-level fee collection patterns alongside Permit2 and Universal Router would be useful for products where a swap is also a revenue path.

### Agent integrations need stricter execution guarantees

One thing this project made very clear is that an agent should not always be allowed to optimize for the route it considers "best."

In our case, an alternative router or aggregator could produce a perfectly valid trade while still failing the application's verification requirements or bypassing its fee path.

For agentic applications, examples showing how to constrain execution to a known route, router, or pool configuration would be valuable.

## Scope and testing

This submission uses the existing Uniswap v3 integration rather than introducing a v4 migration.

We also did not rebuild the full swap stack from scratch for the hackathon. The Continuity work is the agent execution layer and its integration with the existing P2E Inferno swap path.

The public repository and commit history are intended to make that boundary clear.

## Uniswap feedback form

Hackathon feedback is also being submitted through the required Uniswap Developer Feedback Form:

https://developers.uniswap.org/hackathon-feedback