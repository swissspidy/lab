# lab

An open-source loop that lets an agent improve a live website on its own,
and never ships a change that has not been verified.

One iteration: propose a change, build it as a variant, test it in a
sandbox, verify it against compiled checks, serve it to a slice of traffic,
measure one metric, then keep or revert. Every step goes into an
append-only ledger in the site's repository.

"lab" is a working name.

## Kill switch

```sh
npm run lab -- kill path/to/site
```

Every variant share goes to 0% at once, without a build or a deploy: the
edge reads the host state on each request. It works even when the config or
the ledger is broken; it records the kill in the ledger afterwards when it
can.

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

M3 of six milestones is done: the loop ships a verified, approved variant to
a share of traffic, measures it and keeps or reverts it, on simulated
traffic. M4 is partly done (the ledger report and the Graft spec adapter); it
needs a real target site to finish. See [docs/PROGRESS.md](docs/PROGRESS.md).

`lab report` writes the ledger as a static HTML page that someone who has
never seen the repository can read.

With a key (`ANTHROPIC_API_KEY`, or `ant auth login`), let the model propose
and build:

```sh
npm run lab -- run --dry fixtures/site --iterations 3
```

## The full loop

Run `lab run` from a scheduler once per measurement interval. Each run does
one step:

1. If an experiment is live, measure it: roll it back at once if a guardrail
   degraded; once a day, apply the decision rule and keep, revert or keep
   running.
2. Otherwise, if an experiment is approved, ship it to `traffic.share` of
   visitors, unless the site's traffic cannot reach the planned sample size
   within `traffic.maxDays`.
3. Otherwise, if an experiment passed Verify, wait for `lab approve <id>`.
4. Otherwise, start a new iteration: propose, build, verify.

`lab status` shows where things stand. The reference host (`lab publish`,
`lab serve`) serves the baseline and the variant, buckets visitors with a
random first-party id that carries nothing else, and counts visits,
conversions, errors and engagement per bucket and interval, never per
visitor.

### Decision rule

Beta-Binomial posteriors on each bucket's conversion rate:

- keep when P(variant beats baseline) ≥ 0.95, both buckets reached the
  sample size planned at ship time, and no guardrail degraded;
- revert when P ≤ 0.05 (after `minSamplesPerBucket`), when a guardrail
  degrades, or when `maxDays` passes;
- otherwise keep running.

Guardrails (`js_error_rate`, `bounce`) degrade when the variant is worse than
the baseline by more than the margin in `rollback` and by enough standard
errors that chance alone trips one less than 5% of the time over the whole
experiment. They are checked every interval, on that interval alone and on
the totals.

**Peeking.** The rule is evaluated once a day, not continuously, and the
daily looks are not corrected for. In simulation, a variant with no true
effect is kept about 15% of the time (3 of 20). A sequential test would fix
this; it is a later improvement.

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
- `packages/deploy`: the reference deployer, edge server, beacon and meter.
- `packages/report`: the static ledger viewer.
- `packages/adapters`: adapters to Graft (and later Sandburg and Assay).
- `packages/cli`: the `lab` command.
- `fixtures/sim`: the traffic simulator.
- `fixtures/site`: a small static site with two planted flaws.
- `fixtures/good`, `fixtures/breakages`: patches that must pass, and patches
  that must be rejected with a named check.
- `docs/INVENTORY.md`: what Graft, Sandburg and Assay offer the lab today.
- `docs/QUESTIONS.md`: open decisions, with the choice taken meanwhile.

## License

Apache-2.0.
