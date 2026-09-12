# AI-assisted development disclosure

ETHGlobal requires disclosure of AI assistance and, where a spec-driven
workflow was used, the planning artifacts. This is that disclosure.

## What AI assisted with

**The original feature** — the x402 agent gateway, runner, DG Vendor
subgraph, and shared contracts package (the 7 commits `89b43b1` through
`54129dd` in this repo's history) — was built by the human developer
(commit author `DannyThomx`), with AI (Claude Code) used as a coding
assistant throughout, in the normal way of the tool: implementing changes,
writing tests, debugging, at the developer's direction and under their
review. That work is not separately itemized here; it's the substance of
the hackathon submission and its authorship is the commit history itself.

**This public-repo extraction** — everything from the scaffold commit
onward (splitting the private `p2einferno-app` monorepo down to a
standalone, buildable core) — was done in an AI-assisted session (Claude,
via Claude Code) working from the developer's explicit scope and
constraints. Concretely, AI:

- Classified the ~44 cross-package import sites into "vendor as-is" vs.
  "needs an adapter interface," and wrote the adapter interfaces,
  in-memory fixtures, and vendored-module copies under `src/adapters/` and
  `src/vendor/`.
- Ran the `git filter-repo` history extraction that produced this repo's
  base commits, preserving real author/dates.
- Wrote the scaffold (`package.json`, `tsconfig.json`, CI, `.env.example`),
  this disclosure, `FEEDBACK.md`, `docs/world-feedback.md`'s scaffold, and
  the README.
- Rewired import paths mechanically across the extracted source.

**Human direction and review**: the developer set the extraction strategy
(scoped adapter layer, not a full vendor or a reference-only dump — see
`docs/dev-process/carve-out-plan.md`), made the IP/scope calls at each
checkpoint (what to include, what stays private, when to push), reviewed
and approved the plan before implementation began, and is responsible for
final review of this repo's content before submission.

## Planning artifacts included

- `docs/dev-process/carve-out-plan.md` — the approved extraction plan
  (scope, classification, commit sequence, verification approach),
  reviewed for secrets/private content before inclusion (none found).

## What this disclosure does not cover

It does not itemize every prompt exchanged during either the original
feature's development or this extraction session — a full conversation
transcript was judged not to be a "spec or planning artifact" in the sense
the requirement means, and publishing it wholesale risks including
incidental private discussion not relevant to judges. If ETHGlobal's
reviewers need more than the plan document above, ask and it can be
provided out-of-band rather than committed to a public repo by default.
