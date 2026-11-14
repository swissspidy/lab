# lab

An open-source loop that lets an agent improve a live website on its own,
and never ships a change that has not been verified.

One iteration: propose a change, build it as a variant, test it in a
sandbox, verify it against compiled checks, serve it to a slice of traffic,
measure one metric, then keep or revert. Every step goes into an
append-only ledger in the site's repository.

"lab" is a working name.

## Kill switch

`lab kill` will set the variant share to 0% without a deploy. It arrives in
M3, before the lab serves any variant to visitors. Until then the lab ships
nothing.

## Try it in two minutes

Node 22.18 or later, and Playwright's Chromium (`npx playwright install chromium`).

```sh
npm install
npm run lab -- doctor fixtures/site
npm run lab -- run --dry fixtures/site --experiment fixtures/good/nav-docs
npm run lab -- run --dry fixtures/site --experiment fixtures/breakages/changed-price
```

The first experiment adds a Docs link to the fixture site's navigation and
ends in `verify_passed`. The second changes a price and ends in
`verify_failed`, naming `static.claims-numbers`. Both land in
`fixtures/site/lab/ledger.jsonl`; delete that file to run them again.

## Status

M2 of six milestones is done: the dry loop runs from a proposal, written by
Claude or replayed from disk, to a verdict. See [docs/PROGRESS.md](docs/PROGRESS.md).

With a key (`ANTHROPIC_API_KEY`, or `ant auth login`), let the model propose
and build:

```sh
npm run lab -- run --dry fixtures/site --iterations 3
```

## Verification

A variant passes only if every check passes, on top of a baseline that
passes the same suite in the same run:

| Gate | Checks |
| --- | --- |
| Static | patch format, scope and size; site check and build; bundle size; numbers, names, links, forms and pages unchanged |
| Invariants | the site's own `lab/invariants/*.ts`, at every viewport |
| Budgets | aXe, console errors, failed requests, new origins, overflow, LCP, CLS, page status, dead links |
| Acceptance | the experiment's own checks, written as data with the spec |

`npm run check` runs lint, typecheck and all tests.

## How it is built

- `packages/core`: the stage interfaces (`src/types.ts`), the config
  (`lab.config.ts`, written by the site owner), the ledger, the patch and
  spec guards, and the orchestrator.
- `packages/sandbox`: the built-in sandbox.
- `packages/verify`: the built-in verifier.
- `packages/agent`: proposers and builders, replayed or model-backed, and
  the `ModelProvider` they use.
- `packages/cli`: the `lab` command.
- `fixtures/site`: a small static site with two planted flaws.
- `fixtures/good`, `fixtures/breakages`: patches that must pass, and patches
  that must be rejected with a named check.
- `docs/INVENTORY.md`: what Graft, Sandburg and Assay offer the lab today.
- `docs/QUESTIONS.md`: open decisions, with the choice taken meanwhile.

## License

Apache-2.0.
