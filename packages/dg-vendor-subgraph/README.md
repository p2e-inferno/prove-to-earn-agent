# DG Vendor Subgraph

Indexes `TokensPurchased`, `TokensSold`, `Lit` and `StageUpgraded` from the DG
Token Vendor on Base, one row per wallet plus the individual events.

This is what lets an agent answer "how much DG have I bought this month?" from
chain data rather than from its own run reports.

## Target

`subgraph.yaml` indexes the Base **mainnet** vendor
`0x24DD71aDd0026E924e0Fc7a7701A851e2b9c09C4` from its deployment block
`30004995`. Both read rails resolve against The Graph's decentralized network, so
the subgraph tracks mainnet regardless of which vendor `NEXT_PUBLIC_DG_VENDOR_ADDRESS`
points at in a given environment.

## Deploy

```bash
npm install
npm run codegen
npm run build
npx graph auth <studio-deploy-key>
npm run deploy   # deploys the dg-token-vendor slug to Studio
```

Then set `GRAPH_VENDOR_SUBGRAPH_ID` (the deployment id Studio returns) and
`GRAPH_API_KEY` in the app environment.

## x402 reachability

The agent runner queries subgraphs over x402 (`/api/x402/subgraphs/id/<id>`),
which resolves against the decentralized network. A Studio deployment is not on
the network until it is published, so verify this subgraph answers over that
path before pointing the runner at it. Until then the runner reads only the
published Uniswap subgraph over x402, and vendor history is served through the
app's API-key path — no code change either way, only which ids are set.

## Excluded from the app's tooling

The mappings are AssemblyScript, not TypeScript. This directory is excluded from
the root `tsconfig.json`, Jest, ESLint and Prettier; do not remove those
exclusions or `npm run lint` will fail on valid mapping code.
